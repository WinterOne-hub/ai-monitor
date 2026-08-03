<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import * as echarts from "echarts";
import { useI18n } from "vue-i18n";
import { balanceSeriesFrom, usageEventsFrom, initDb } from "../core/db";

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

  // 统一用「起止日期」窗口（预设范围也换算成绝对日期，规避 datetime 参数问题）
  const now = Date.now();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  let startDateStr: string;
  if (props.startDate) {
    startDateStr = props.startDate;
  } else {
    const d = new Date(now - (props.days ?? 30) * 24 * 3600 * 1000);
    startDateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const xMin = new Date(startDateStr + "T00:00:00").getTime();
  const xMax = props.endDate
    ? new Date(props.endDate + "T23:59:59").getTime()
    : now;

  // 余额快照 + token 事件（均按起始日期查询）
  const balRows = await balanceSeriesFrom(props.accountId, startDateStr);
  const tokRows = await usageEventsFrom(props.accountId, startDateStr);

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

  // 时间轴格式：按范围跨度统一（短范围显示时间，长范围显示日期）
  const spanMs = xMax - xMin;
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
    graphic: [
      {
        type: "text",
        left: 8,
        bottom: 4,
        style: {
          text: t("dashboard.chartZoomHint"),
          fill: "#6b7280",
          fontSize: 10,
        },
      },
    ],
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        start: 0,
        end: 100,
        zoomOnMouseWheel: true, // 滚轮/手势缩放
        moveOnMouseMove: true, // 拖拽平移
        moveOnMouseWheel: false,
      },
    ],
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
  // 双击重置缩放
  chart.off("dblclick");
  chart.on("dblclick", () => {
    chart?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
  });
}

function handleResize(): void {
  chart?.resize();
}

function showError(e: unknown): void {
  console.error("chart render error", e);
  if (chart) {
    chart.clear();
    chart.setOption({
      backgroundColor: "transparent",
      title: {
        text: `Chart error: ${(e as Error).message || String(e)}`,
        left: "center",
        top: "middle",
        textStyle: { color: "#f87171", fontSize: 11, lineHeight: 18 },
      },
    });
  }
}

onMounted(async () => {
  // 确保数据库已初始化（子组件先于父组件挂载）
  await initDb();
  if (!chartEl.value) return;
  chart = echarts.init(chartEl.value);
  await render().catch(showError);
  window.addEventListener("resize", handleResize);
});

watch(
  () => [props.accountId, props.days, props.startDate, props.endDate],
  () => void render().catch(showError)
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
