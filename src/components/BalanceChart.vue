<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import * as echarts from "echarts";
import { balanceSeries, balanceSeriesFrom, dailyUsageSeries } from "../core/db";

const props = defineProps<{
  accountId: number | null;
  days?: number;
  startDate?: string;
}>();

const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

async function render(): Promise<void> {
  if (!chart || !props.accountId) return;
  // 余额快照（按天取最后一条）
  const balRows = props.startDate
    ? await balanceSeriesFrom(props.accountId, props.startDate)
    : await balanceSeries(props.accountId, props.days ?? 30);
  // 每日 token 用量
  const usageRows = props.startDate
    ? await dailyUsageSeries(props.accountId, 3650)
    : await dailyUsageSeries(props.accountId, props.days ?? 30);

  if (balRows.length === 0 && usageRows.length === 0) {
    chart.clear();
    chart.setOption({
      backgroundColor: "transparent",
      title: {
        text: "暂无余额/用量记录\n（添加账户并刷新后显示趋势）",
        left: "center",
        top: "middle",
        textStyle: { color: "#6b7280", fontSize: 12, lineHeight: 20 },
      },
    });
    return;
  }

  // 按天合并：余额取当天最后一条，token 累加
  const dayMap: Record<string, { balance: number | null; tokens: number }> = {};
  for (const r of balRows) {
    const day = r.fetched_at.slice(0, 10);
    dayMap[day] = { balance: r.balance, tokens: dayMap[day]?.tokens ?? 0 };
  }
  for (const u of usageRows) {
    if (!dayMap[u.date]) dayMap[u.date] = { balance: null, tokens: 0 };
    dayMap[u.date].tokens += u.tokens;
  }
  const dates = Object.keys(dayMap).sort();
  const balances = dates.map((d) => dayMap[d].balance);
  const tokens = dates.map((d) => dayMap[d].tokens);

  chart.setOption({
    backgroundColor: "transparent",
    legend: {
      data: ["Balance", "Tokens"],
      textStyle: { color: "#9ca3af", fontSize: 11 },
      top: 0,
      right: 8,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(23, 26, 36, 0.95)",
      borderColor: "rgba(255,255,255,0.1)",
      textStyle: { color: "#e5e7eb", fontSize: 12 },
    },
    grid: { left: 12, right: 16, top: 28, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: true,
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
      axisTick: { show: false },
      axisLabel: { color: "#6b7280", fontSize: 10 },
    },
    yAxis: [
      {
        type: "value",
        scale: true,
        name: "¥",
        nameTextStyle: { color: "#6b7280", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
        axisLabel: { color: "#6b7280", fontSize: 10, formatter: (v: number) => `¥${v}` },
      },
      {
        type: "value",
        scale: true,
        name: "tok",
        nameTextStyle: { color: "#6b7280", fontSize: 10 },
        splitLine: { show: false },
        axisLabel: {
          color: "#6b7280",
          fontSize: 10,
          formatter: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)),
        },
      },
    ],
    series: [
      {
        name: "Balance",
        type: "line",
        yAxisIndex: 0,
        data: balances,
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
      {
        name: "Tokens",
        type: "bar",
        yAxisIndex: 1,
        data: tokens,
        barMaxWidth: 18,
        itemStyle: { color: "rgba(96, 165, 250, 0.45)", borderRadius: [3, 3, 0, 0] },
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
