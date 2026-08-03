<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import * as echarts from "echarts";
import { useI18n } from "vue-i18n";
import { balanceSeries, balanceSeriesFrom, usageEventsSeries } from "../core/db";

const props = defineProps<{
  accountId: number | null;
  days?: number;
  startDate?: string;
  endDate?: string;
}>();

const { t } = useI18n();
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

/** Safari/WKWebView 不解析 'YYYY-MM-DD HH:MM:SS'，需转 ISO */
function parseLocal(s: string): number {
  return new Date(s.replace(" ", "T")).getTime();
}

async function render(): Promise<void> {
  if (!chart || !props.accountId) return;
  // 余额快照（保留高时间分辨率）
  const balRows = props.startDate
    ? await balanceSeriesFrom(props.accountId, props.startDate)
    : await balanceSeries(props.accountId, props.days ?? 30);
  // 每次调用的 token 事件（分钟级）
  const tokRows = props.startDate
    ? await usageEventsSeries(props.accountId, 3650)
    : await usageEventsSeries(props.accountId, props.days ?? 30);

  if (balRows.length === 0 && tokRows.length === 0) {
    chart.clear();
    chart.setOption({
      backgroundColor: "transparent",
      title: {
        text: t("dashboard.chartEmpty"),
        left: "center",
        top: "middle",
        textStyle: { color: "#6b7280", fontSize: 12, lineHeight: 20 },
      },
    });
    return;
  }

  const balData = balRows.map((r) => [parseLocal(r.fetched_at), r.balance]);
  const tokData = tokRows.map((r) => [
    parseLocal(r.created_at),
    r.input_tokens + r.output_tokens,
  ]);

  // x 轴窗口：按所选范围固定（切换 1/7/30/自定义有明显效果）
  const now = Date.now();
  const xMin = props.startDate
    ? new Date(props.startDate + "T00:00:00").getTime()
    : now - (props.days ?? 30) * 24 * 3600 * 1000;
  const xMax = props.endDate
    ? new Date(props.endDate + "T23:59:59").getTime()
    : now;

  // 时间轴格式：按范围跨度统一（短范围显示时间，长范围显示日期）
  const spanMs = xMax - xMin;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtTime = (ts: number): string => {
    const d = new Date(ts);
    if (spanMs < 2 * 24 * 3600 * 1000) {
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    if (spanMs < 31 * 24 * 3600 * 1000) {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };

  chart.setOption({
    backgroundColor: "transparent",
    legend: {
      data: [t("dashboard.chartBalance"), t("dashboard.chartTokens")],
      textStyle: { color: "#9ca3af", fontSize: 11 },
      top: 0,
      left: 8,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(23, 26, 36, 0.95)",
      borderColor: "rgba(255,255,255,0.1)",
      textStyle: { color: "#e5e7eb", fontSize: 12 },
    },
    grid: { left: 12, right: 12, top: 28, bottom: 8, containLabel: true },
    xAxis: {
      type: "time",
      min: xMin,
      max: xMax,
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
      axisTick: { show: false },
      axisLabel: {
        color: "#6b7280",
        fontSize: 10,
        hideOverlap: true,
        formatter: (v: number) => fmtTime(v),
      },
    },
    yAxis: [
      {
        type: "value",
        scale: true,
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
        axisLabel: {
          color: "#60a5fa",
          fontSize: 10,
          formatter: (v: number) => `¥${v}`,
        },
      },
      {
        type: "value",
        scale: true,
        splitLine: { show: false },
        axisLabel: {
          color: "#34d399",
          fontSize: 10,
          formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)),
        },
      },
    ],
    series: [
      {
        name: t("dashboard.chartTokens"),
        type: "line",
        yAxisIndex: 1,
        data: tokData,
        smooth: false,
        showSymbol: tokData.length <= 60,
        lineStyle: { color: "#60a5fa", width: 1.5 },
        itemStyle: { color: "#60a5fa" },
      },
      {
        name: t("dashboard.chartBalance"),
        type: "line",
        yAxisIndex: 0,
        data: balData,
        connectNulls: true,
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { color: "#34d399", width: 2 },
        itemStyle: { color: "#34d399" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(52, 211, 153, 0.25)" },
            { offset: 1, color: "rgba(52, 211, 153, 0)" },
          ]),
        },
      },
    ],
  });
}

function handleResize(): void {
  chart?.resize();
}

onMounted(() => {
  if (!chartEl.value) return;
  chart = echarts.init(chartEl.value);
  void render();
  window.addEventListener("resize", handleResize);
});

watch(
  () => [props.accountId, props.days, props.startDate],
  () => void render()
);

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div ref="chartEl" class="chart"></div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: 240px;
}
</style>
