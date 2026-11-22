import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

import {
  formatDateStr,
  getDailySnapshot,
  getMultiDayTrend,
} from './garmin-service.js';
import { publishToGitHubPages } from './setup-github-pages.js';

const DASHBOARD_PATH = path.join(PROJECT_ROOT, 'dashboard.html');
const TEIDE_DATE = new Date('2027-03-07T02:00:00');

function getYesterdayDateStr(todayStr) {
  const d = new Date(`${todayStr}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return formatDateStr(d);
}

function fmtHoursMin(hoursDecimal) {
  if (hoursDecimal === null || hoursDecimal === undefined) return '—';
  const totalMin = Math.round(hoursDecimal * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtMinToHM(min) {
  if (min === null || min === undefined) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

async function fetchWithRetry(retries = 4, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const todayStr = formatDateStr();
      const yesterdayStr = getYesterdayDateStr(todayStr);
      const [yesterday, today, trend14] = await Promise.all([
        getDailySnapshot(yesterdayStr),
        getDailySnapshot(todayStr),
        getMultiDayTrend(14, todayStr),
      ]);
      return { todayStr, yesterdayStr, yesterday, today, trend14 };
    } catch (err) {
      console.error(`Intento ${i + 1}/${retries} fallido (${err.message}). Reintentando en ${delayMs / 1000}s...`);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function buildDashboardHtml({ todayStr, yesterdayStr, yesterday, today, trend14 }) {
  // Teide countdown (handles 2026/2027 March 7th dynamically)
  const nowObj = new Date(`${todayStr}T09:00:00`);
  let targetTeide = new Date(`${nowObj.getFullYear()}-03-07T02:00:00`);
  if (targetTeide < nowObj) {
    targetTeide = new Date(`${nowObj.getFullYear() + 1}-03-07T02:00:00`);
  }
  const daysToTeide = Math.max(
    0,
    Math.ceil((targetTeide - nowObj) / (1000 * 60 * 60 * 24))
  );

  // Metrics from today (recovery) & yesterday (activity/stress)
  const bbTodayHigh = today.wellnessAndEnergy?.bodyBattery?.highest ?? today.wellnessAndEnergy?.bodyBattery?.mostRecent ?? '—';
  const bbTodayRecent = today.wellnessAndEnergy?.bodyBattery?.mostRecent ?? '—';
  const bbOvernightCharge = today.sleep?.bodyBatteryChangeOvernight ?? today.wellnessAndEnergy?.bodyBattery?.charged ?? 0;
  const bbYestHigh = yesterday.wellnessAndEnergy?.bodyBattery?.highest ?? '—';
  const bbYestLow = yesterday.wellnessAndEnergy?.bodyBattery?.lowest ?? '—';

  const sleepHoursToday = today.sleep?.sleepTimeHours;
  const sleepScoreToday = today.sleep?.sleepScore ?? '—';
  const deepMinToday = today.sleep?.deepSleepMinutes ?? 0;
  const remMinToday = today.sleep?.remSleepMinutes ?? 0;
  const awakeMinToday = today.sleep?.awakeMinutes ?? 0;

  const sleepHoursYest = yesterday.sleep?.sleepTimeHours;
  const sleepScoreYest = yesterday.sleep?.sleepScore ?? '—';
  const deepMinYest = yesterday.sleep?.deepSleepMinutes ?? 0;
  const remMinYest = yesterday.sleep?.remSleepMinutes ?? 0;
  const awakeMinYest = yesterday.sleep?.awakeMinutes ?? 0;
  const bbOvernightYest = yesterday.sleep?.bodyBatteryChangeOvernight ?? yesterday.wellnessAndEnergy?.bodyBattery?.charged ?? 0;

  const hrvToday = today.wellnessAndEnergy?.hrv?.lastNightAvg ?? '—';
  const hrvWeekly = today.wellnessAndEnergy?.hrv?.weeklyAvg ?? yesterday.wellnessAndEnergy?.hrv?.weeklyAvg ?? '—';
  const hrvStatus = today.wellnessAndEnergy?.hrv?.status ?? 'BALANCED';
  const hrvYest = yesterday.wellnessAndEnergy?.hrv?.lastNightAvg ?? '—';

  const rhrToday = today.wellnessAndEnergy?.restingHeartRate ?? '—';
  const rhrYest = yesterday.wellnessAndEnergy?.restingHeartRate ?? '—';
  const rhrDiff =
    typeof rhrToday === 'number' && typeof rhrYest === 'number'
      ? rhrToday - rhrYest
      : null;

  const stressYestAvg = yesterday.wellnessAndEnergy?.stress?.averageStressLevel ?? '—';
  const medMinYest = yesterday.activities?.totalMeditationMinutes ?? 0;
  const lastMed = yesterday.activities?.meditations?.[0] || trend14.activities?.find((a) => a.category === 'MEDITACION_Y_RESPIRACION');

  const stepsYest = yesterday.caloriesAndBodyComposition?.steps ?? 0;
  const floorsYest = Math.round(yesterday.caloriesAndBodyComposition?.floorsAscended ?? 0);
  const totalKcalYest = yesterday.caloriesAndBodyComposition?.totalKilocalories ?? 0;
  const activeKcalYest = yesterday.caloriesAndBodyComposition?.activeKilocalories ?? 0;

  // 14-day aggregates for Teide & Meditation
  const allActs = trend14.activities || [];
  const sportActs = allActs.filter((a) => a.category === 'DEPORTE');
  const medActs = allActs.filter((a) => a.category === 'MEDITACION_Y_RESPIRACION');
  const hikingActs = sportActs.filter((a) => a.type === 'hiking' || a.type === 'mountaineering');
  const totalElevation14d = sportActs.reduce((acc, a) => acc + (a.elevationGainMeters || 0), 0);
  const strengthAndClimbCount = sportActs.filter(
    (a) => a.type === 'strength_training' || a.type === 'mountaineering' || a.type === 'bouldering'
  ).length;

  // Stress distribution percentages yesterday
  const sRest = yesterday.wellnessAndEnergy?.stress?.restStressDurationMinutes || 0;
  const sLow = yesterday.wellnessAndEnergy?.stress?.lowStressDurationMinutes || 0;
  const sMed = yesterday.wellnessAndEnergy?.stress?.mediumStressDurationMinutes || 0;
  const sHigh = yesterday.wellnessAndEnergy?.stress?.highStressDurationMinutes || 0;
  const sTotal = Math.max(1, sRest + sLow + sMed + sHigh);
  const pRest = +((sRest / sTotal) * 100).toFixed(1);
  const pLow = +((sLow / sTotal) * 100).toFixed(1);
  const pMed = +((sMed / sTotal) * 100).toFixed(1);
  const pHigh = +((sHigh / sTotal) * 100).toFixed(1);

  // Automatic Coach Readiness status
  const isReadyHigh =
    (typeof bbTodayHigh === 'number' && bbTodayHigh >= 75) ||
    (typeof sleepScoreToday === 'number' && sleepScoreToday >= 75);
  const readinessBadge = isReadyHigh
    ? '🟢 Óptimo para Montaña / Zona 2 o Fuerza'
    : '🟡 Priorizar Recuperación Activa y Meditación';

  const yestSportsSummary =
    yesterday.activities?.sports?.length > 0
      ? yesterday.activities.sports
          .map((s) => `${s.name} (${s.durationMinutes} min, FC media ${s.averageHR || '—'} ppm)`)
          .join(' + ')
      : 'Sin sesión deportiva registrada (día de descanso deportivo)';

  const yestMedSummary =
    yesterday.activities?.meditations?.length > 0
      ? yesterday.activities.meditations
          .map(
            (m) =>
              `${m.durationMinutes} min a ${m.averageHR || '—'} ppm (estrés ${m.startStress ?? '—'} → ${m.endStress ?? '—'}, Δ ${m.differenceStress ?? 0})`
          )
          .join(', ')
      : 'No se registró sesión de meditación ayer';

  // Build chart dataset JSON for sport sessions
  const chartSessions = [...sportActs]
    .reverse()
    .slice(-10)
    .map((s) => ({
      label: `${(s.startTimeLocal || '').slice(8, 10)}/${(s.startTimeLocal || '').slice(5, 7)} ${(s.name || '').slice(0, 10)}`,
      duration: s.durationMinutes || 0,
      load: +(s.activityTrainingLoad || 0).toFixed(1),
    }));

  // Build Meditation cards HTML
  const medCardsHtml = medActs
    .slice(0, 4)
    .map((m) => {
      const diff = m.differenceStress ?? 0;
      const badgeColor =
        diff <= 0
          ? 'text-[var(--success)]'
          : diff <= 15
          ? 'text-[var(--warning)]'
          : 'text-[var(--error)]';
      const borderClass =
        diff <= 0 ? 'border-2 border-[var(--success)]' : 'border border-[var(--card-border)]';
      const diffText = diff > 0 ? `Δ +${diff} estrés` : `Δ ${diff} (Estable/Baja)`;
      return `
        <div class="p-3.5 rounded-lg bg-[var(--background)] ${borderClass} space-y-1.5">
          <div class="flex justify-between items-center font-semibold">
            <span>${(m.startTimeLocal || '').slice(0, 16)}</span>
            <span class="font-mono ${badgeColor}">${diffText}</span>
          </div>
          <div class="font-mono text-xs text-[var(--muted-foreground)]">
            ${m.durationMinutes} min · ${m.averageHR || '—'} ppm · ${m.avgRespirationRate ? m.avgRespirationRate.toFixed(1) : '—'} rpm
          </div>
          <div class="text-xs">
            Estrés: <strong>${m.startStress ?? '—'} → ${m.endStress ?? '—'}</strong> (Media ${m.avgStress ?? '—'})
          </div>
        </div>`;
    })
    .join('\n');

  // Build 14-day table rows HTML
  const tableRowsHtml = allActs
    .map((a) => {
      const isMed = a.category === 'MEDITACION_Y_RESPIRACION';
      const isHike = a.type === 'hiking';
      const catLabel = isMed ? 'CALMA' : isHike ? 'TEIDE / MONTAÑA' : 'DEPORTE';
      const catColor = isMed
        ? 'text-[var(--success)]'
        : isHike
        ? 'text-[var(--warning)]'
        : 'text-[var(--primary)]';
      const icon = isMed ? '🧘‍♂️' : isHike ? '🥾' : a.type === 'mountaineering' ? '🧗‍♂️' : '💪';
      const distOrResp = isMed
        ? `${a.avgRespirationRate ? a.avgRespirationRate.toFixed(1) + ' rpm' : '—'}`
        : `${a.distanceKm ? a.distanceKm + ' km' : a.calories ? a.calories + ' kcal' : '—'}${a.elevationGainMeters ? ' · +' + a.elevationGainMeters + ' m' : ''}`;
      const impact = isMed
        ? `Estrés: ${a.startStress ?? '—'} → ${a.endStress ?? '—'} (Δ ${a.differenceStress ?? 0})`
        : `Load ${a.activityTrainingLoad ? a.activityTrainingLoad.toFixed(1) : '—'} · Aer ${a.aerobicTrainingEffect ? a.aerobicTrainingEffect.toFixed(1) : '0'}`;

      return `
        <tr>
          <td class="py-2 pr-3">${(a.startTimeLocal || '').slice(0, 16)}</td>
          <td class="py-2 pr-3 font-sans font-semibold">${icon} ${a.name}</td>
          <td class="py-2 pr-3 ${catColor}">${catLabel}</td>
          <td class="py-2 pr-3">${a.durationMinutes} min</td>
          <td class="py-2 pr-3">${distOrResp}</td>
          <td class="py-2 pr-3">${a.averageHR || '—'} / ${a.maxHR || '—'} ppm</td>
          <td class="py-2 pr-3">${impact}</td>
        </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Garmin Fenix 7 Studio — Teide 0-4-0 & Calma</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <script>
    if (!getComputedStyle(document.documentElement).getPropertyValue('--background').trim()) {
      const s = document.documentElement.style;
      s.setProperty('--background', '#0f172a');
      s.setProperty('--card', '#1e293b');
      s.setProperty('--border', '#334155');
      s.setProperty('--card-border', '#334155');
      s.setProperty('--foreground', '#f8fafc');
      s.setProperty('--muted-foreground', '#94a3b8');
      s.setProperty('--primary', '#3b82f6');
      s.setProperty('--primary-foreground', '#ffffff');
      s.setProperty('--success', '#22c55e');
      s.setProperty('--warning', '#f59e0b');
      s.setProperty('--error', '#ef4444');
    }
  </script>
</head>
<body class="bg-[var(--background)] text-[var(--foreground)] antialiased p-4 md:p-6 m-0 space-y-6">

  <header class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
    <div class="space-y-1">
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 text-xs font-semibold rounded-md bg-[var(--primary)] text-[var(--primary-foreground)]">
          GARMIN FENIX 7 STUDIO
        </span>
        <span class="text-xs text-[var(--muted-foreground)] font-mono">
          Actualizado: ${todayStr} · Informe Matutino Automático
        </span>
      </div>
      <h1 class="text-lg md:text-xl font-bold tracking-tight">
        Panel Diario: Reto Teide 0-4-0 (7 Mar) &amp; Calma / Sistema Nervioso
      </h1>
      <p class="text-xs text-[var(--muted-foreground)]">
        Cierre completo de ayer (${yesterdayStr}) + Recuperación nocturna de hoy (${todayStr})
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-1.5 bg-[var(--background)] p-1 rounded-lg border border-[var(--card-border)] text-xs">
      <button onclick="switchTab('overview')" id="tab-overview" class="px-3 py-1.5 rounded-md font-medium bg-[var(--primary)] text-[var(--primary-foreground)] transition">
        Resumen Matutino IA
      </button>
      <button onclick="switchTab('teide')" id="tab-teide" class="px-3 py-1.5 rounded-md font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
        Reto Teide (7 Mar)
      </button>
      <button onclick="switchTab('calm')" id="tab-calm" class="px-3 py-1.5 rounded-md font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
        Meditación &amp; VFC
      </button>
      <button onclick="switchTab('log')" id="tab-log" class="px-3 py-1.5 rounded-md font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition">
        Histórico 14 Días
      </button>
    </div>
  </header>

  <section class="grid grid-cols-2 lg:grid-cols-5 gap-3">
    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3.5 space-y-1.5">
      <div class="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>Body Battery (Hoy)</span>
        <span class="font-mono text-[var(--success)] font-semibold">+${bbOvernightCharge} noche</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-bold font-mono tabular-nums">${bbTodayHigh}</span>
        <span class="text-xs text-[var(--muted-foreground)]">/ 100 (Actual: ${bbTodayRecent})</span>
      </div>
      <div class="w-full h-1.5 bg-[var(--background)] rounded-full overflow-hidden">
        <div class="h-full bg-[var(--success)] rounded-full" style="width: ${typeof bbTodayHigh === 'number' ? bbTodayHigh : 50}%"></div>
      </div>
      <p class="text-xs text-[var(--muted-foreground)]">
        Ayer: máx ${bbYestHigh} → mín ${bbYestLow}
      </p>
    </div>

    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3.5 space-y-1.5">
      <div class="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>Sueño de Anoche</span>
        <span class="font-mono text-[var(--success)] font-semibold">Score: ${sleepScoreToday}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-bold font-mono tabular-nums">${fmtHoursMin(sleepHoursToday)}</span>
        <span class="text-xs text-[var(--muted-foreground)]">vs ${fmtHoursMin(sleepHoursYest)} ant.</span>
      </div>
      <div class="flex gap-1 text-xs text-[var(--muted-foreground)] font-mono">
        <span>Prof: ${fmtMinToHM(deepMinToday)}</span> · <span>REM: ${fmtMinToHM(remMinToday)}</span>
      </div>
      <p class="text-xs text-[var(--success)]">
        ${typeof sleepScoreToday === 'number' && sleepScoreToday >= 75 ? '🟢 Meta > 75 superada' : '🟡 Cuidar descanso esta noche'}
      </p>
    </div>

    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3.5 space-y-1.5">
      <div class="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>VFC (HRV) &amp; FC Reposo</span>
        <span class="font-mono text-[var(--success)] font-semibold">${hrvStatus}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-bold font-mono tabular-nums">${hrvToday} ms</span>
        <span class="text-xs text-[var(--muted-foreground)]">${rhrToday} ppm RHR</span>
      </div>
      <p class="text-xs text-[var(--muted-foreground)]">
        Ayer: ${hrvYest} ms · Media 7d: ${hrvWeekly} ms
      </p>
      <p class="text-xs text-[var(--success)]">
        ${rhrDiff !== null ? `Variación RHR: ${rhrDiff > 0 ? '+' + rhrDiff : rhrDiff} ppm` : 'Termómetro autonómico'}
      </p>
    </div>

    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3.5 space-y-1.5">
      <div class="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>Meditación &amp; Estrés (Ayer)</span>
        <span class="font-mono text-[var(--warning)] font-semibold">Estrés: ${stressYestAvg}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-bold font-mono tabular-nums">${medMinYest} min</span>
        <span class="text-xs text-[var(--muted-foreground)]">${trend14.totals?.daysWithMeditation || 0}d / 14d</span>
      </div>
      <p class="text-xs text-[var(--muted-foreground)]">
        ${lastMed ? `Última: ${lastMed.startStress ?? '—'} → ${lastMed.endStress ?? '—'} (Δ ${lastMed.differenceStress ?? 0})` : 'Sin sesiones recientes'}
      </p>
      <p class="text-xs text-[var(--success)]">
        Meta: 5–7 días/semana (10–15m)
      </p>
    </div>

    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-3.5 space-y-1.5 col-span-2 lg:col-span-1">
      <div class="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
        <span>Reto Teide 0-4-0</span>
        <span class="font-mono text-[var(--primary)] font-semibold">Faltan ${daysToTeide} días</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-bold font-mono tabular-nums">${stepsYest.toLocaleString('es-ES')}</span>
        <span class="text-xs text-[var(--muted-foreground)]">pasos ayer (+${floorsYest} pisos)</span>
      </div>
      <p class="text-xs text-[var(--muted-foreground)]">
        Ayer: ${totalKcalYest} kcal (${activeKcalYest} act)
      </p>
      <p class="text-xs text-[var(--warning)]">
        Desnivel 14d: +${totalElevation14d} m
      </p>
    </div>
  </section>

  <!-- TAB 1: OVERVIEW -->
  <div id="panel-overview" class="space-y-6">
    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-[var(--card-border)]">
        <div>
          <h2 class="text-base font-bold">
            🧠 Interpretación Matutina del Coach IA (Balance de Ayer + Sueño de Hoy)
          </h2>
          <p class="text-xs text-[var(--muted-foreground)]">
            Evaluación cruzada de tus actividades del ${yesterdayStr} y cómo las ha asimilado tu cuerpo esta noche (${todayStr})
          </p>
        </div>
        <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-[var(--background)] border border-[var(--card-border)]">
          Estado Hoy: ${readinessBadge}
        </span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs leading-relaxed">
        <div class="bg-[var(--background)] border border-[var(--card-border)] rounded-lg p-3.5 space-y-2">
          <div class="font-semibold text-sm flex items-center justify-between">
            <span>1. El Día de Ayer (${yesterdayStr})</span>
            <span class="font-mono text-xs text-[var(--primary)]">${stepsYest.toLocaleString('es-ES')} pasos</span>
          </div>
          <p class="text-[var(--muted-foreground)]">
            <strong>Deporte:</strong> ${yestSportsSummary}. Acumulaste <strong>${stepsYest.toLocaleString('es-ES')} pasos</strong> y <strong>${floorsYest} pisos</strong> subidos (${activeKcalYest} kcal activas / ${totalKcalYest} kcal totales).
          </p>
          <p class="text-[var(--muted-foreground)]">
            <strong>Meditación y Calma:</strong> ${yestMedSummary}. El estrés medio del día cerró en <strong>${stressYestAvg}/100</strong> con una Body Battery que osciló entre ${bbYestHigh} y ${bbYestLow}.
          </p>
        </div>

        <div class="bg-[var(--background)] border border-[var(--card-border)] rounded-lg p-3.5 space-y-2">
          <div class="font-semibold text-sm flex items-center justify-between">
            <span>2. Respuesta Nocturna (${todayStr})</span>
            <span class="font-mono text-xs text-[var(--success)]">Score ${sleepScoreToday}</span>
          </div>
          <p class="text-[var(--muted-foreground)]">
            Has dormido <strong>${fmtHoursMin(sleepHoursToday)}</strong> (Puntuación: <strong>${sleepScoreToday}/100</strong>), con <strong>${fmtMinToHM(deepMinToday)}</strong> de sueño profundo y <strong>${fmtMinToHM(remMinToday)}</strong> de sueño REM.
          </p>
          <p class="text-[var(--muted-foreground)]">
            Tu <strong>VFC (HRV)</strong> nocturna ha marcado <strong>${hrvToday} ms</strong> (media semanal: ${hrvWeekly} ms) y tu frecuencia cardíaca en reposo está en <strong>${rhrToday} ppm</strong>, recargando tu Body Battery en <strong>+${bbOvernightCharge} puntos</strong> hasta <strong>${bbTodayHigh}</strong>.
          </p>
        </div>

        <div class="bg-[var(--background)] border border-[var(--card-border)] rounded-lg p-3.5 space-y-2">
          <div class="font-semibold text-sm flex items-center justify-between">
            <span>3. Plan Recomendado para Hoy</span>
            <span class="font-mono text-xs text-[var(--primary)]">Faltan ${daysToTeide}d Teide</span>
          </div>
          <ul class="space-y-1.5 text-[var(--muted-foreground)] list-disc pl-4">
            <li>
              <strong>Objetivo Teide (7 Mar):</strong> ${isReadyHigh ? 'Con tu nivel alto de energía hoy, es un día excelente para sumar desnivel en Zona 2 (105–135 ppm) o realizar sesión de Fuerza/Escalada.' : 'Prioriza hoy caminata suave en Zona 1–2 o movilidad sin forzar picos anaeróbicos para proteger el sistema nervioso.'}
            </li>
            <li>
              <strong>Objetivo Calma:</strong> Reserva <strong>10–15 minutos entre las 20:00 y las 21:30</strong> (idealmente tras soltar tensión física) para tu sesión diaria de meditación.
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-bold">Distribución del Estrés y Descanso (Ayer ${yesterdayStr})</h3>
            <p class="text-xs text-[var(--muted-foreground)]">Tiempo en cada zona fisiológica del Fenix 7</p>
          </div>
          <span class="text-xs font-mono font-semibold">Media: ${stressYestAvg} / 100</span>
        </div>

        <div class="space-y-2.5 pt-1 text-xs">
          <div>
            <div class="flex justify-between mb-1">
              <span>Descanso / Recuperación (&lt; 25)</span>
              <span class="font-mono">${sRest} min (${pRest}%)</span>
            </div>
            <div class="w-full h-2.5 bg-[var(--background)] rounded-full overflow-hidden">
              <div class="h-full rounded-full" style="width: ${pRest}%; background: var(--success)"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between mb-1">
              <span>Estrés Bajo (26 – 50)</span>
              <span class="font-mono">${sLow} min (${pLow}%)</span>
            </div>
            <div class="w-full h-2.5 bg-[var(--background)] rounded-full overflow-hidden">
              <div class="h-full rounded-full" style="width: ${pLow}%; background: var(--primary)"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between mb-1">
              <span>Estrés Medio (51 – 75)</span>
              <span class="font-mono">${sMed} min (${pMed}%)</span>
            </div>
            <div class="w-full h-2.5 bg-[var(--background)] rounded-full overflow-hidden">
              <div class="h-full rounded-full" style="width: ${pMed}%; background: var(--warning)"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between mb-1">
              <span>Estrés Alto (76 – 100)</span>
              <span class="font-mono">${sHigh} min (${pHigh}%)</span>
            </div>
            <div class="w-full h-2.5 bg-[var(--background)] rounded-full overflow-hidden">
              <div class="h-full rounded-full" style="width: ${pHigh}%; background: var(--error)"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-bold">Comparativa de Sueño y Recuperación Autonómica</h3>
            <p class="text-xs text-[var(--muted-foreground)]">Noche anterior (${yesterdayStr}) vs Anoche (${todayStr})</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 pt-1 text-xs">
          <div class="p-3 rounded-lg bg-[var(--background)] border border-[var(--card-border)] space-y-2">
            <div class="flex items-center justify-between font-semibold text-[var(--muted-foreground)]">
              <span>Noche ${yesterdayStr}</span>
              <span class="font-mono">Score ${sleepScoreYest}</span>
            </div>
            <div class="space-y-1 font-mono text-xs">
              <div class="flex justify-between"><span>Tiempo total:</span><strong>${fmtHoursMin(sleepHoursYest)}</strong></div>
              <div class="flex justify-between"><span>Sueño Profundo:</span><span>${deepMinYest} min</span></div>
              <div class="flex justify-between"><span>Sueño REM:</span><span>${remMinYest} min</span></div>
              <div class="flex justify-between"><span>Despierto:</span><span>${awakeMinYest} min</span></div>
              <div class="flex justify-between"><span>VFC Nocturna:</span><span>${hrvYest} ms</span></div>
              <div class="flex justify-between"><span>Recarga Battery:</span><span>+${bbOvernightYest} pts</span></div>
            </div>
          </div>

          <div class="p-3 rounded-lg bg-[var(--background)] border border-[var(--card-border)] space-y-2">
            <div class="flex items-center justify-between font-semibold">
              <span>Anoche (${todayStr})</span>
              <span class="text-[var(--success)] font-mono">Score ${sleepScoreToday}</span>
            </div>
            <div class="space-y-1 font-mono text-xs">
              <div class="flex justify-between"><span>Tiempo total:</span><strong class="text-[var(--success)]">${fmtHoursMin(sleepHoursToday)}</strong></div>
              <div class="flex justify-between"><span>Sueño Profundo:</span><span>${deepMinToday} min</span></div>
              <div class="flex justify-between"><span>Sueño REM:</span><span>${remMinToday} min</span></div>
              <div class="flex justify-between"><span>Despierto:</span><span>${awakeMinToday} min</span></div>
              <div class="flex justify-between"><span>VFC Nocturna:</span><span class="text-[var(--success)]">${hrvToday} ms</span></div>
              <div class="flex justify-between"><span>Recarga Battery:</span><span class="text-[var(--success)]">+${bbOvernightCharge} pts</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 2: TEIDE -->
  <div id="panel-teide" class="hidden space-y-6">
    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-[var(--card-border)]">
        <div>
          <h2 class="text-base font-bold">🏔️ Hoja de Ruta Teide 0-4-0 (Nivel del Mar → Refugio · 7 de Marzo)</h2>
          <p class="text-xs text-[var(--muted-foreground)]">
            Salida 02:00 AM · Meta: +3.300 m a +3.700 m de desnivel positivo · Faltan ${daysToTeide} días
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div class="p-3.5 rounded-lg bg-[var(--background)] border border-[var(--card-border)] space-y-2">
          <div class="flex justify-between font-semibold">
            <span>Desnivel Acumulado (Últimos 14 días)</span>
            <span class="font-mono">+${totalElevation14d} m</span>
          </div>
          <div class="w-full h-2.5 bg-[var(--card)] rounded-full overflow-hidden">
            <div class="h-full bg-[var(--warning)] rounded-full" style="width: ${Math.min(100, Math.round((totalElevation14d / 1200) * 100))}%"></div>
          </div>
          <p class="text-[var(--muted-foreground)]">
            Salidas de montaña/senderismo en 14 días: <strong>${hikingActs.length} sesiones</strong>. Meta Fase 1 (Nov–Dic): 500–900 m semanales en Zona 2.
          </p>
        </div>

        <div class="p-3.5 rounded-lg bg-[var(--background)] border border-[var(--card-border)] space-y-2">
          <div class="flex justify-between font-semibold">
            <span>Fuerza + Escalada (14 días)</span>
            <span class="font-mono text-[var(--success)]">${strengthAndClimbCount} sesiones</span>
          </div>
          <div class="w-full h-2.5 bg-[var(--card)] rounded-full overflow-hidden">
            <div class="h-full bg-[var(--success)] rounded-full" style="width: ${Math.min(100, Math.round((strengthAndClimbCount / 6) * 100))}%"></div>
          </div>
          <p class="text-[var(--muted-foreground)]">
            Blindaje muscular y articular para soportar horas de subida y bajada con mochila.
          </p>
        </div>

        <div class="p-3.5 rounded-lg bg-[var(--background)] border border-[var(--card-border)] space-y-2">
          <div class="flex justify-between font-semibold">
            <span>Tiempo Deportivo Total (14 días)</span>
            <span class="font-mono">${fmtMinToHM(trend14.totals?.totalSportMinutes || 0)}</span>
          </div>
          <div class="w-full h-2.5 bg-[var(--card)] rounded-full overflow-hidden">
            <div class="h-full bg-[var(--primary)] rounded-full" style="width: 80%"></div>
          </div>
          <p class="text-[var(--muted-foreground)]">
            ${trend14.totals?.sportSessions || 0} entrenamientos registrados y ${trend14.totals?.totalDistanceKm || 0} km acumulados.
          </p>
        </div>
      </div>

      <div class="pt-2 space-y-2">
        <div class="flex items-center justify-between text-xs">
          <span class="font-semibold">Duración (min) y Training Load por Sesión Deportiva (Últimos 14 días)</span>
          <span class="text-[var(--muted-foreground)]">Azul: Duración (min) · Verde: Training Load</span>
        </div>
        <div class="w-full bg-[var(--background)] border border-[var(--card-border)] rounded-lg p-3">
          <canvas id="teideChart" height="190" class="w-full"></canvas>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 3: MEDITACION & VFC -->
  <div id="panel-calm" class="hidden space-y-6">
    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-[var(--card-border)]">
        <div>
          <h2 class="text-base font-bold">🧘‍♂️ Laboratorio de Meditación, Calma y Regulación Emocional</h2>
          <p class="text-xs text-[var(--muted-foreground)]">
            ${trend14.totals?.meditationSessions || 0} sesiones (${trend14.totals?.totalMeditationMinutes || 0} min) en los últimos 14 días
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        ${medCardsHtml}
      </div>

      <div class="p-4 rounded-lg bg-[var(--background)] border border-[var(--card-border)] text-xs space-y-1.5">
        <div class="font-bold text-sm">💡 Protocolo Personalizado de Meditación (Fenix 7)</div>
        <p class="text-[var(--muted-foreground)]">
          Mover el cuerpo 10 minutos (fuerza suave, movilidad o caminata) por la tarde-noche (20:00–21:30) y acto seguido realizar 10–15 minutos de meditación evita la rumiación mental, estabiliza el estrés (Δ ≤ 0) y maximiza el sueño profundo y REM.
        </p>
      </div>
    </div>
  </div>

  <!-- TAB 4: HISTORICO 14 DIAS -->
  <div id="panel-log" class="hidden space-y-6">
    <div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 space-y-3">
      <div class="flex items-center justify-between pb-2 border-b border-[var(--card-border)]">
        <div>
          <h2 class="text-base font-bold">📋 Registro Completo de Actividades (Últimos 14 Días)</h2>
          <p class="text-xs text-[var(--muted-foreground)]">${trend14.totals?.sportSessions || 0} sesiones deportivas + ${trend14.totals?.meditationSessions || 0} sesiones de meditación</p>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-[var(--card-border)] text-[var(--muted-foreground)]">
              <th class="py-2 pr-3">Fecha y Hora</th>
              <th class="py-2 pr-3">Actividad</th>
              <th class="py-2 pr-3">Categoría</th>
              <th class="py-2 pr-3">Duración</th>
              <th class="py-2 pr-3">Dist / Desnivel / Resp</th>
              <th class="py-2 pr-3">FC Media / Máx</th>
              <th class="py-2 pr-3">Carga / Impacto</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--card-border)] font-mono">
            ${tableRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const tabs = ['overview', 'teide', 'calm', 'log'];
    function switchTab(active) {
      tabs.forEach((t) => {
        const panel = document.getElementById('panel-' + t);
        const btn = document.getElementById('tab-' + t);
        if (t === active) {
          panel.classList.remove('hidden');
          btn.className = 'px-3 py-1.5 rounded-md font-medium bg-[var(--primary)] text-[var(--primary-foreground)] transition';
        } else {
          panel.classList.add('hidden');
          btn.className = 'px-3 py-1.5 rounded-md font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition';
        }
      });
      if (active === 'teide') drawTeideChart();
    }

    const sessions = ${JSON.stringify(chartSessions)};

    function drawTeideChart() {
      const canvas = document.getElementById('teideChart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;

      canvas.width = rect.width * dpr;
      canvas.height = 190 * dpr;
      ctx.scale(dpr, dpr);

      const style = getComputedStyle(document.documentElement);
      const fg = style.getPropertyValue('--foreground').trim() || '#e5e7eb';
      const muted = style.getPropertyValue('--muted-foreground').trim() || '#9ca3af';
      const primary = style.getPropertyValue('--primary').trim() || '#3b82f6';
      const success = style.getPropertyValue('--success').trim() || '#22c55e';
      const border = style.getPropertyValue('--card-border').trim() || 'rgba(128,128,128,0.2)';

      ctx.clearRect(0, 0, rect.width, 190);

      const padLeft = 36, padRight = 16, padTop = 20, padBottom = 38;
      const chartW = rect.width - padLeft - padRight;
      const chartH = 190 - padTop - padBottom;
      const maxVal = Math.max(130, ...sessions.map((s) => Math.max(s.duration, s.load)));

      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      [0, 30, 60, 90, 120].forEach((val) => {
        const y = padTop + chartH - (val / maxVal) * chartH;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + chartW, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(String(val), padLeft - 6, y + 3);
      });

      const slotW = chartW / Math.max(1, sessions.length);
      const barW = Math.min(22, slotW * 0.34);

      sessions.forEach((s, idx) => {
        const centerX = padLeft + idx * slotW + slotW / 2;
        const durH = (s.duration / maxVal) * chartH;
        ctx.fillStyle = primary;
        ctx.fillRect(centerX - barW - 2, padTop + chartH - durH, barW, durH);

        const loadH = (s.load / maxVal) * chartH;
        ctx.fillStyle = success;
        ctx.fillRect(centerX + 2, padTop + chartH - loadH, barW, loadH);

        ctx.fillStyle = fg;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s.label, centerX, padTop + chartH + 18);
      });
    }

    window.addEventListener('resize', drawTeideChart);
    window.addEventListener('themechange', drawTeideChart);
  </script>
</body>
</html>`;
}

async function main() {
  const isCloud = process.argv.includes('--cloud');
  const noOpen = process.argv.includes('--no-open') || isCloud;
  console.log('Conectando con Garmin Connect para actualizar el Dashboard Matutino...');
  const data = await fetchWithRetry();
  const html = buildDashboardHtml(data);
  fs.writeFileSync(DASHBOARD_PATH, html, 'utf8');
  console.log(`✅ Dashboard actualizado en: ${DASHBOARD_PATH}`);

  if (isCloud) {
    const indexPath = path.join(PROJECT_ROOT, 'index.html');
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log(`✅ index.html generado para GitHub Pages en: ${indexPath}`);
    return;
  }

  if (process.env.GITHUB_TOKEN) {
    try {
      const { url } = await publishToGitHubPages(process.env.GITHUB_TOKEN, html);
      console.log(`🌐 Dashboard móvil actualizado en: ${url}`);
    } catch (err) {
      console.error('Aviso: No se pudo sincronizar con GitHub Pages:', err.message);
    }
  }

  if (!noOpen) {
    exec(`start "" "${DASHBOARD_PATH}"`);
  }
}

main().catch((err) => {
  console.error('❌ Error al actualizar el Dashboard:', err.message);
  process.exit(1);
});
