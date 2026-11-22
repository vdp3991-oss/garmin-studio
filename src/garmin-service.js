import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import garminConnectPkg from 'garmin-connect';

const { GarminConnect } = garminConnectPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TOKEN_DIR = path.join(PROJECT_ROOT, '.garmin_tokens');
const GOALS_PATH = path.join(PROJECT_ROOT, 'objetivos.md');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');

/**
 * Formats a Date object as YYYY-MM-DD in local timezone (or configured TZ).
 */
export function formatDateStr(date = new Date()) {
  const tz = process.env.TIMEZONE || 'Europe/Madrid';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/**
 * Initializes and authenticates the Garmin Connect client.
 * Uses saved OAuth tokens when available to avoid SSO rate limits.
 */
export async function getGarminClient() {
  dotenv.config({ path: ENV_PATH, override: true });
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  const client = new GarminConnect({
    username: email || '',
    password: password || '',
  });

  // Restore tokens from Base64 env var if running in cloud (GitHub Actions / Render)
  if (process.env.GARMIN_TOKENS_BASE64) {
    try {
      const decoded = JSON.parse(
        Buffer.from(process.env.GARMIN_TOKENS_BASE64, 'base64').toString('utf8')
      );
      if (decoded.oauth1 && decoded.oauth2) {
        client.loadToken(decoded.oauth1, decoded.oauth2);
        return client;
      }
    } catch (err) {
      console.error('Aviso: No se pudo cargar GARMIN_TOKENS_BASE64, intentando login normal:', err.message);
    }
  }

  // Restore tokens from local disk if available
  const oauth1Path = path.join(TOKEN_DIR, 'oauth1_token.json');
  const oauth2Path = path.join(TOKEN_DIR, 'oauth2_token.json');
  if (fs.existsSync(oauth1Path) && fs.existsSync(oauth2Path)) {
    try {
      client.loadTokenByFile(TOKEN_DIR);
      return client;
    } catch (err) {
      console.error('Aviso: Tokens locales expirados o inválidos, re-autenticando...');
    }
  }

  if (!email || !password) {
    throw new Error(
      'Faltan credenciales de Garmin (GARMIN_EMAIL y GARMIN_PASSWORD en .env o GARMIN_TOKENS_BASE64).'
    );
  }

  await client.login(email, password);
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    client.exportTokenToFile(TOKEN_DIR);
  } catch (err) {
    // Non-fatal if running in read-only filesystem
  }

  return client;
}

/**
 * Safe helper to execute a Garmin API call without failing the entire report if one endpoint is unavailable.
 */
async function safeCall(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { _unavailable: true, reason: `${label}: ${err.message}` };
  }
}

/**
 * Determines whether an activity is a meditation / breathwork / mindfulness session.
 */
function isMeditationOrMindfulness(activity) {
  const typeKey = (activity?.activityType?.typeKey || '').toLowerCase();
  const name = (activity?.activityName || '').toLowerCase();
  return (
    typeKey.includes('meditation') ||
    typeKey.includes('breathwork') ||
    typeKey.includes('respiration') ||
    typeKey.includes('mindfulness') ||
    name.includes('medit') ||
    name.includes('respir') ||
    name.includes('breath') ||
    name.includes('mindfulness')
  );
}

/**
 * Normalizes a Garmin activity object into clean metrics for Gemini.
 */
function normalizeActivity(act) {
  const durationMin = act.duration ? +(act.duration / 60).toFixed(1) : 0;
  const distanceKm = act.distance ? +(act.distance / 1000).toFixed(2) : 0;
  const isMeditation = isMeditationOrMindfulness(act);

  return {
    id: act.activityId,
    name: act.activityName,
    type: act.activityType?.typeKey || 'unknown',
    category: isMeditation ? 'MEDITACION_Y_RESPIRACION' : 'DEPORTE',
    startTimeLocal: act.startTimeLocal,
    durationMinutes: durationMin,
    distanceKm: distanceKm > 0 ? distanceKm : undefined,
    calories: act.calories,
    averageHR: act.averageHR,
    maxHR: act.maxHR,
    aerobicTrainingEffect: act.aerobicTrainingEffect,
    anaerobicTrainingEffect: act.anaerobicTrainingEffect,
    trainingEffectLabel: act.trainingEffectLabel,
    activityTrainingLoad: act.activityTrainingLoad,
    avgStress: act.avgStress,
    startStress: act.startStress,
    endStress: act.endStress,
    differenceStress:
      act.endStress !== undefined && act.startStress !== undefined
        ? +(act.endStress - act.startStress).toFixed(1)
        : undefined,
    minRespirationRate: act.minRespirationRate,
    maxRespirationRate: act.maxRespirationRate,
    avgRespirationRate: act.avgRespirationRate,
    elevationGainMeters: act.elevationGain ? Math.round(act.elevationGain) : undefined,
  };
}

/**
 * Fetches a comprehensive snapshot for a given date (YYYY-MM-DD):
 * - Activities (separated into Sports & Meditation/Breathwork)
 * - Daily User Summary (Steps, Calories total/active/BMR, Stress avg/max, Body Battery charged/drained/high/low, Resting HR)
 * - Sleep Data (Duration, Sleep Score, REM/Deep/Light/Awake, Overnight HRV & Resting HR)
 * - HRV Status (VFC last night avg, weekly avg, baseline, status)
 * - Weight & Body Composition (Weight kg, BMI, body fat %, muscle mass)
 */
export async function getDailySnapshot(dateStr = formatDateStr()) {
  const client = await getGarminClient();
  const dateObj = new Date(`${dateStr}T12:00:00`);

  // 1. Fetch recent activities and filter by dateStr
  const recentActivitiesRaw = await safeCall('activities', () =>
    client.getActivities(0, 30)
  );
  const dayActivities = Array.isArray(recentActivitiesRaw)
    ? recentActivitiesRaw
        .filter((a) => (a.startTimeLocal || '').startsWith(dateStr))
        .map(normalizeActivity)
    : [];

  const sportActivities = dayActivities.filter((a) => a.category === 'DEPORTE');
  const meditationActivities = dayActivities.filter(
    (a) => a.category === 'MEDITACION_Y_RESPIRACION'
  );

  // 2. Daily summary (stress, body battery, steps, active/total calories, RHR)
  const userSummary = await safeCall('userSummary', async () => {
    const profile = await client.getUserProfile();
    const displayName = profile?.displayName || profile?.userName;
    if (displayName && typeof client.get === 'function') {
      return await client.get(
        `https://connectapi.garmin.com/usersummary-service/usersummary/daily/${displayName}?calendarDate=${dateStr}`
      );
    }
    return null;
  });

  // 3. Sleep data
  const sleepData = await safeCall('sleepData', () =>
    client.getSleepData(dateObj)
  );

  // 4. HRV (VFC) data
  const hrvData = await safeCall('hrvData', async () => {
    if (typeof client.get === 'function') {
      return await client.get(
        `https://connectapi.garmin.com/hrv-service/hrv/${dateStr}`
      );
    }
    return null;
  });

  // 5. Body Battery daily events (including how activities/meditation affected Body Battery)
  const bodyBatteryEvents = await safeCall('bodyBattery', async () => {
    if (typeof client.get === 'function') {
      return await client.get(
        `https://connectapi.garmin.com/wellness-service/wellness/bodyBattery/reports/daily?startDate=${dateStr}&endDate=${dateStr}`
      );
    }
    return null;
  });

  // 6. Weight & Body Composition
  const weightData = await safeCall('weightData', async () => {
    if (typeof client.getDailyWeightData === 'function') {
      return await client.getDailyWeightData(dateObj);
    }
    return null;
  });

  // Extract clean summary metrics
  const dailyDto = sleepData?.dailySleepDTO || {};
  const sleepScore = dailyDto?.sleepScores?.overall?.value ?? null;
  const sleepSeconds = dailyDto?.sleepTimeSeconds ?? null;

  const summaryClean = {
    date: dateStr,
    activities: {
      totalCount: dayActivities.length,
      sportCount: sportActivities.length,
      meditationCount: meditationActivities.length,
      totalMeditationMinutes: +meditationActivities
        .reduce((acc, a) => acc + (a.durationMinutes || 0), 0)
        .toFixed(1),
      totalSportMinutes: +sportActivities
        .reduce((acc, a) => acc + (a.durationMinutes || 0), 0)
        .toFixed(1),
      sports: sportActivities,
      meditations: meditationActivities,
    },
    wellnessAndEnergy: {
      restingHeartRate:
        userSummary?.restingHeartRate ?? sleepData?.restingHeartRate ?? null,
      minHeartRate: userSummary?.minHeartRate ?? null,
      maxHeartRate: userSummary?.maxHeartRate ?? null,
      stress: {
        averageStressLevel: userSummary?.averageStressLevel ?? null,
        maxStressLevel: userSummary?.maxStressLevel ?? null,
        restStressDurationMinutes: userSummary?.restStressDuration
          ? Math.round(userSummary.restStressDuration / 60)
          : null,
        lowStressDurationMinutes: userSummary?.lowStressDuration
          ? Math.round(userSummary.lowStressDuration / 60)
          : null,
        mediumStressDurationMinutes: userSummary?.mediumStressDuration
          ? Math.round(userSummary.mediumStressDuration / 60)
          : null,
        highStressDurationMinutes: userSummary?.highStressDuration
          ? Math.round(userSummary.highStressDuration / 60)
          : null,
      },
      bodyBattery: {
        charged: userSummary?.bodyBatteryChargedValue ?? null,
        drained: userSummary?.bodyBatteryDrainedValue ?? null,
        highest: userSummary?.bodyBatteryHighestValue ?? null,
        lowest: userSummary?.bodyBatteryLowestValue ?? null,
        mostRecent: userSummary?.bodyBatteryMostRecentValue ?? null,
        feedbackEvents: Array.isArray(bodyBatteryEvents)
          ? bodyBatteryEvents[0]?.bodyBatteryActivityEventList || []
          : [],
      },
      hrv: {
        lastNightAvg:
          hrvData?.hrvSummary?.lastNightAvg ??
          sleepData?.avgOvernightHrv ??
          null,
        weeklyAvg: hrvData?.hrvSummary?.weeklyAvg ?? null,
        status:
          hrvData?.hrvSummary?.status ?? sleepData?.hrvStatus ?? null,
        feedbackPhrase: hrvData?.hrvSummary?.feedbackPhrase ?? null,
      },
    },
    sleep: {
      sleepTimeHours: sleepSeconds ? +(sleepSeconds / 3600).toFixed(2) : null,
      sleepScore,
      deepSleepMinutes: dailyDto?.deepSleepSeconds
        ? Math.round(dailyDto.deepSleepSeconds / 60)
        : null,
      lightSleepMinutes: dailyDto?.lightSleepSeconds
        ? Math.round(dailyDto.lightSleepSeconds / 60)
        : null,
      remSleepMinutes: dailyDto?.remSleepSeconds
        ? Math.round(dailyDto.remSleepSeconds / 60)
        : null,
      awakeMinutes: dailyDto?.awakeSleepSeconds
        ? Math.round(dailyDto.awakeSleepSeconds / 60)
        : null,
      bodyBatteryChangeOvernight: sleepData?.bodyBatteryChange ?? null,
    },
    caloriesAndBodyComposition: {
      totalKilocalories: userSummary?.totalKilocalories ?? null,
      activeKilocalories: userSummary?.activeKilocalories ?? null,
      bmrKilocalories: userSummary?.bmrKilocalories ?? null,
      steps: userSummary?.totalSteps ?? null,
      dailyStepGoal: userSummary?.dailyStepGoal ?? null,
      floorsAscended: userSummary?.floorsAscended ?? null,
      moderateIntensityMinutes: userSummary?.moderateIntensityMinutes ?? null,
      vigorousIntensityMinutes: userSummary?.vigorousIntensityMinutes ?? null,
      weightKg: weightData?.totalAverage?.weight
        ? +(weightData.totalAverage.weight / 1000).toFixed(2)
        : null,
      bodyFatPercentage: weightData?.totalAverage?.bodyFat ?? null,
      bmi: weightData?.totalAverage?.bmi ?? null,
    },
  };

  return summaryClean;
}

/**
 * Fetches multi-day trend (default last 7 days) so Gemini can evaluate weekly progress against goals.
 */
export async function getMultiDayTrend(days = 7, endDateStr = formatDateStr()) {
  const client = await getGarminClient();
  const recentActivitiesRaw = await safeCall('activities', () =>
    client.getActivities(0, 60)
  );
  const allNormalized = Array.isArray(recentActivitiesRaw)
    ? recentActivitiesRaw.map(normalizeActivity)
    : [];

  const dates = [];
  const endObj = new Date(`${endDateStr}T12:00:00`);
  for (let i = 0; i < days; i++) {
    const d = new Date(endObj);
    d.setDate(endObj.getDate() - i);
    dates.push(formatDateStr(d));
  }

  const startDateStr = dates[dates.length - 1];
  const windowActivities = allNormalized.filter((a) => {
    const d = (a.startTimeLocal || '').slice(0, 10);
    return d >= startDateStr && d <= endDateStr;
  });

  const sports = windowActivities.filter((a) => a.category === 'DEPORTE');
  const meditations = windowActivities.filter(
    (a) => a.category === 'MEDITACION_Y_RESPIRACION'
  );

  return {
    period: { startDate: startDateStr, endDate: endDateStr, days },
    totals: {
      sportSessions: sports.length,
      totalSportMinutes: +sports
        .reduce((acc, a) => acc + (a.durationMinutes || 0), 0)
        .toFixed(1),
      totalDistanceKm: +sports
        .reduce((acc, a) => acc + (a.distanceKm || 0), 0)
        .toFixed(2),
      meditationSessions: meditations.length,
      totalMeditationMinutes: +meditations
        .reduce((acc, a) => acc + (a.durationMinutes || 0), 0)
        .toFixed(1),
      daysWithMeditation: new Set(
        meditations.map((m) => (m.startTimeLocal || '').slice(0, 10))
      ).size,
    },
    activities: windowActivities,
  };
}

/**
 * Fetches detailed information for a specific activity by ID.
 */
export async function getActivityDetails(activityId) {
  const client = await getGarminClient();
  const details = await safeCall('activityDetails', () =>
    client.getActivity({ activityId: Number(activityId) })
  );
  return details;
}

/**
 * Reads user goals from objetivos.md
 */
export function readGoals() {
  if (!fs.existsSync(GOALS_PATH)) {
    return 'No hay objetivos definidos aún.';
  }
  return fs.readFileSync(GOALS_PATH, 'utf8');
}

/**
 * Updates user goals in objetivos.md
 */
export function writeGoals(newContent) {
  fs.writeFileSync(GOALS_PATH, newContent, 'utf8');
  return readGoals();
}
