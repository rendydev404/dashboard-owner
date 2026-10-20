// Registrasi Chart.js minimal (tree-shaken). Dimuat lazy oleh charts.tsx.
import {
  Chart, BarController, LineController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler,
} from "chart.js";

Chart.register(BarController, LineController, BarElement, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend, Filler);
Chart.defaults.font.family = '"Inter Variable", system-ui, sans-serif';

export { Chart };
