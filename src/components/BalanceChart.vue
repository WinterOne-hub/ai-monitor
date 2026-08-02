<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import * as echarts from "echarts";
import { balanceSeries } from "../core/db";

const props = defineProps<{ accountId: number | null }>();

const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

async function render(): Promise<void> {
  if (!chart || !props.accountId) return;
  const rows = await balanceSeries(props.accountId, 30);
  if (rows.length === 0) {
    chart.clear();
    chart.setOption({
      backgroundColor: "transparent",
      title: {
        text: "暂无余额记录\n（添加账户并刷新后显示趋势）",
        left: "center",
        top: "middle",
        textStyle: { color: "#6b7280", fontSize: 12, lineHeight: 20 },
      },
    });
    return;
  }
  const dates = rows.map((r) => r.fetched_at.slice(5, 16));
  const values = rows.map((r) => r.balance);
  chart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(23, 26, 36, 0.95)",
      borderColor: "rgba(255,255,255,0.1)",
      textStyle: { color: "#e5e7eb", fontSize: 12 },
      valueFormatter: (v: unknown) => `¥${Number(v).toFixed(2)}`,
    },
    grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
      axisTick: { show: false },
      axisLabel: { color: "#6b7280", fontSize: 10 },
    },
    yAxis: {
      type: "value",
      scale: true,
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
      axisLabel: { color: "#6b7280", fontSize: 10, formatter: (v: number) => `¥${v}` },
    },
    series: [
      {
        type: "line",
        data: values,
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
  () => props.accountId,
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
