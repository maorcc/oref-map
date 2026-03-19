export const PROVIDERS = {
  OFFICIAL: 'official',
  TZEVA_ADOM: 'tzeva-adom',
};

export const TZEVA_ADOM_TARGET = 'https://tzevadom.com/api/alerts-history/summary/custom';

const TZEVA_ADOM_TO_OFFICIAL_API = {
  0: 1,
  2: 3,
  3: 2, // an old alert type used only on 26/10/2024 04:02 for Drone from Lebanon
  5: 2,
  11: 14
};

const OFFICIAL_CATEGORY_MAP = {
  1: 'ירי רקטות וטילים',
  2: 'חדירת כלי טיס עוין',
  3: 'חדירת מחבלים',
  4: 'רעידת אדמה',
  5: 'חשש לצונאמי',
  6: 'אירוע חומרים מסוכנים',
  7: 'אירוע רדיולוגי',
  10: 'חשש לאירוע ביולוגי',
  13: 'האירוע הסתיים',
  14: 'בדקות הקרובות צפויות להתקבל התרעות באזורך',
  99: 'ללא שיוך'
};

export function normalizeProvider(rawValue) {
  const value = String(rawValue || PROVIDERS.OFFICIAL)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');

  if (!value || value === PROVIDERS.OFFICIAL) return PROVIDERS.OFFICIAL;
  if (value === PROVIDERS.TZEVA_ADOM || value === 'tzevaadom') return PROVIDERS.TZEVA_ADOM;
  return null;
}

function formatYmd(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatIsoSeconds(dateObj) {
  const options = {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };
  return new Intl.DateTimeFormat('sv', options).format(dateObj).replace(' ', 'T');
}

export function parseDdMmYyyy(dateStr, endOfDay) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(dateStr || ''));
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);
  const hours = endOfDay ? 23 : 0;
  const minutes = endOfDay ? 59 : 0;
  const seconds = endOfDay ? 59 : 0;
  const millis = endOfDay ? 999 : 0;

  const parsed = new Date(year, month, day, hours, minutes, seconds, millis);
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
  return parsed;
}

export function buildRange(modeRaw, fromDateStr, toDateStr) {
  let mode = String(modeRaw || '1');
  if (fromDateStr && toDateStr) mode = '0';

  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);

  if (mode === '1' || mode === '2' || mode === '3') {
    const days = mode === '1' ? 1 : (mode === '2' ? 7 : 30);
    const startTs = nowTs - (days * 86400);
    const endTs = nowTs;
    return {
      ok: true,
      mode: mode,
      startTs: startTs,
      endTs: endTs,
      tFrom: formatYmd(new Date(startTs * 1000)),
      tTo: formatYmd(new Date(endTs * 1000)),
    };
  }

  if (mode === '0' && fromDateStr && toDateStr) {
    const startDate = parseDdMmYyyy(fromDateStr, false);
    const endDate = parseDdMmYyyy(toDateStr, true);
    if (!startDate || !endDate) {
      return {ok: false, status: 400, error: 'Invalid date format. Please use DD.MM.YYYY'};
    }
    if (startDate.getTime() > endDate.getTime()) {
      return {ok: false, status: 400, error: 'Invalid date range. fromDate must be earlier than or equal to toDate.'};
    }
    return {
      ok: true,
      mode: mode,
      startTs: Math.floor(startDate.getTime() / 1000),
      endTs: Math.floor(endDate.getTime() / 1000),
      tFrom: formatYmd(startDate),
      tTo: formatYmd(endDate),
    };
  }

  return {ok: false, status: 400, error: 'Missing or invalid parameters'};
}

function mapTzevaTypeToOfficialCategory(typeValue) {
  const normalized = Number(typeValue);
  if (Number.isFinite(normalized) && Object.prototype.hasOwnProperty.call(TZEVA_ADOM_TO_OFFICIAL_API, normalized)) {
    return TZEVA_ADOM_TO_OFFICIAL_API[normalized];
  }
  const asString = String(typeValue);
  if (Object.prototype.hasOwnProperty.call(TZEVA_ADOM_TO_OFFICIAL_API, asString)) {
    return TZEVA_ADOM_TO_OFFICIAL_API[asString];
  }
  return 99;
}

function transformTzevaPayload(payload, startTs, endTs) {
  const alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  if (alerts.length === 0) return [];

  const transformed = [];

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i] || {};
    const cities = Array.isArray(alert.cities) ? alert.cities : [];
    if (cities.length === 0) continue;

    const startTime = Number(alert.startTime);
    if (Number.isFinite(startTime) && startTime >= startTs && startTime <= endTs) {
      const startCategory = mapTzevaTypeToOfficialCategory(alert.type);
      if (startCategory === 99) {
        console.error(`Unknown Tzeva Adom type: ${alert.type}, at time: ${startTime}`);
      }
      const startCategoryDesc = OFFICIAL_CATEGORY_MAP[startCategory] || OFFICIAL_CATEGORY_MAP[99];
      const startAlertDate = formatIsoSeconds(new Date(startTime * 1000));

      for (let c = 0; c < cities.length; c++) {
        const city = cities[c];
        if (city === null || city === undefined) continue;
        const cityName = String(city).trim();
        if (!cityName) continue;

        transformed.push({
          data: cityName,
          alertDate: startAlertDate,
          category_desc: startCategoryDesc,
          category: startCategory,
          rid: 0,
          __timestamp: startTime,
        });
      }
    }

    const endTime = Number(alert.endTime);
    if (Number.isFinite(endTime) && endTime > 0 && endTime >= startTs && endTime <= endTs) {
      const endCategory = 13;
      const endCategoryDesc = OFFICIAL_CATEGORY_MAP[endCategory];
      const endAlertDate = formatIsoSeconds(new Date(endTime * 1000));

      for (let c = 0; c < cities.length; c++) {
        const city = cities[c];
        if (city === null || city === undefined) continue;
        const cityName = String(city).trim();
        if (!cityName) continue;

        transformed.push({
          data: cityName,
          alertDate: endAlertDate,
          category_desc: endCategoryDesc,
          category: endCategory,
          rid: 0,
          __timestamp: endTime,
        });
      }
    }
  }

  transformed.sort(function (a, b) {
    return b.__timestamp - a.__timestamp;
  });

  return transformed.map(function (entry) {
    return {
      data: entry.data,
      alertDate: entry.alertDate,
      category_desc: entry.category_desc,
      category: entry.category,
      rid: entry.rid,
    };
  });
}

export async function fetchTzevaAdomHistory(range) {
  const target = `${TZEVA_ADOM_TARGET}/${range.tFrom}/${range.tTo}`;
  let response;
  try {
    response = await fetch(target);
  } catch (error) {
    throw new Error(`Failed to fetch from Tzeva Adom: ${error && error.message ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch from Tzeva Adom: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Failed to parse Tzeva Adom response JSON');
  }

  return transformTzevaPayload(payload, range.startTs, range.endTs);
}
