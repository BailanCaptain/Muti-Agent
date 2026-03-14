const fs = require('fs');
const path = require('path');

const WINDOWS = {
  fiveHours: 5 * 60 * 60 * 1000,
  oneDay: 24 * 60 * 60 * 1000,
  oneWeek: 7 * 24 * 60 * 60 * 1000,
};

const OFFICIAL_QUOTA_GUIDES = {
  codex: {
    brief: '官方公开 5 小时额度与共享周额度概念。',
    sources: [
      'https://openai.com/index/introducing-codex/',
      'https://help.openai.com/en/articles/11369540-codex-in-chatgpt-usage-limits',
    ],
  },
  claude: {
    brief: '官方公开 5 小时额度，部分计划还有周额度。',
    sources: [
      'https://support.anthropic.com/en/articles/11014257-what-are-claude-code-usage-limits',
      'https://support.anthropic.com/en/articles/11403662-about-claude-s-max-plan-usage',
    ],
  },
  gemini: {
    brief: '官方主要公开 RPM、TPM、RPD 这类 API 配额。',
    sources: [
      'https://github.com/google-gemini/gemini-cli',
      'https://ai.google.dev/gemini-api/docs/rate-limits',
      'https://cloud.google.com/gemini/docs/quotas',
    ],
  },
};

function fileExists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function sumBy(events, selector) {
  return events.reduce((total, event) => total + Number(selector(event) || 0), 0);
}

function pickLatestEvent(events, filter) {
  const matched = filter ? events.filter(filter) : events.slice();
  if (!matched.length) {
    return null;
  }

  return matched.reduce((latest, current) =>
    latest.createdAt > current.createdAt ? latest : current
  );
}

function countEventsSince(events, windowMs, filter) {
  const now = Date.now();
  return events.filter((event) => {
    if (filter && !filter(event)) {
      return false;
    }

    const createdAt = Date.parse(event.createdAt);
    return Number.isFinite(createdAt) && now - createdAt <= windowMs;
  }).length;
}

function sumUsage(events, field) {
  return sumBy(events, (event) => event.meta && event.meta.usage && event.meta.usage[field]);
}

function buildAuth(provider) {
  const home = process.env.USERPROFILE || '';

  if (provider === 'codex') {
    const authPath = path.join(home, '.codex', 'auth.json');
    return fileExists(authPath) ? '已登录' : '未检测到登录';
  }

  if (provider === 'claude') {
    const authPath = path.join(home, '.claude', '.credentials.json');
    return fileExists(authPath) ? '已登录' : '未检测到登录';
  }

  const authPath = path.join(home, '.gemini', 'oauth_creds.json');
  return fileExists(authPath) ? '已登录' : '未检测到登录';
}

function buildGeminiProjectHint() {
  const home = process.env.USERPROFILE || '';
  const projectsPath = path.join(home, '.gemini', 'projects.json');
  const projectMap = readJsonFile(projectsPath);
  const cwd = process.cwd().toLowerCase();
  const currentProject =
    projectMap &&
    projectMap.projects &&
    Object.entries(projectMap.projects)
      .sort((left, right) => String(right[0]).length - String(left[0]).length)
      .find(([key]) => cwd.startsWith(String(key).toLowerCase()));

  return currentProject ? currentProject[1] : null;
}

function buildUsageSummary(events) {
  const successEvents = events.filter(
    (event) => (event.type === 'result' || event.type === 'stop') && event.meta && event.meta.usage
  );
  const latestUsageEvent = pickLatestEvent(successEvents);
  const latestUsage = latestUsageEvent ? latestUsageEvent.meta.usage : null;

  return {
    requestCount5h: countEventsSince(events, WINDOWS.fiveHours, (event) => event.type === 'request'),
    requestCountToday: countEventsSince(events, WINDOWS.oneDay, (event) => event.type === 'request'),
    requestCount7d: countEventsSince(events, WINDOWS.oneWeek, (event) => event.type === 'request'),
    totalRequests: events.filter((event) => event.type === 'request').length,
    limitedCount7d: countEventsSince(
      events,
      WINDOWS.oneWeek,
      (event) => event.status === 'limited' || event.type === 'limit'
    ),
    inputTokensTotal: sumUsage(successEvents, 'inputTokens'),
    outputTokensTotal: sumUsage(successEvents, 'outputTokens'),
    cachedTokensTotal: sumUsage(successEvents, 'cachedInputTokens'),
    totalTokensTotal: sumUsage(successEvents, 'totalTokens'),
    latestInputTokens: latestUsage ? Number(latestUsage.inputTokens || 0) : null,
    latestOutputTokens: latestUsage ? Number(latestUsage.outputTokens || 0) : null,
    latestCachedTokens: latestUsage ? Number(latestUsage.cachedInputTokens || 0) : null,
    latestTotalTokens: latestUsage ? Number(latestUsage.totalTokens || 0) : null,
    latestAt: latestUsageEvent ? latestUsageEvent.createdAt : null,
  };
}

function buildQuotaWindow(events) {
  const latestSignalEvent = pickLatestEvent(
    events,
    (event) => event.meta && event.meta.quotaSignal
  );
  const signal = latestSignalEvent && latestSignalEvent.meta ? latestSignalEvent.meta.quotaSignal : null;

  if (!signal) {
    return {
      status: 'unknown',
      windowType: null,
      resetsAt: null,
      label: '暂无窗口数据',
    };
  }

  return {
    status: signal.status || 'unknown',
    windowType: signal.windowType || null,
    resetsAt: signal.resetsAt || null,
    label: signal.windowType
      ? `${signal.windowType}${signal.status ? ` / ${signal.status}` : ''}`
      : signal.status || 'unknown',
  };
}

function buildRemaining(provider) {
  if (provider === 'gemini') {
    return {
      available: false,
      value: null,
      label: '剩余额度',
      reason: 'CLI 返回本次 token 用量，但没有返回当前项目剩余 token 或剩余请求数。',
    };
  }

  return {
    available: false,
    value: null,
    label: '剩余额度',
    reason: '网页能看到不等于 CLI 提供了公开接口；当前没有发现稳定可编程的剩余额度返回值。',
  };
}

function buildQuotaSnapshot(store, provider) {
  const events = store.listUsageEvents(provider);
  const usage = buildUsageSummary(events);
  const windowInfo = buildQuotaWindow(events);
  const latestLimit = pickLatestEvent(events, (event) => event.status === 'limited' || event.type === 'limit');
  const remaining = buildRemaining(provider);

  const compactCards = [
    { key: 'input_total', label: '累计输入', value: usage.inputTokensTotal, unit: 'tokens' },
    { key: 'output_total', label: '累计输出', value: usage.outputTokensTotal, unit: 'tokens' },
    { key: 'total_total', label: '累计总量', value: usage.totalTokensTotal, unit: 'tokens' },
    { key: 'latest_total', label: '最近一次', value: usage.latestTotalTokens, unit: 'tokens' },
    { key: 'requests_5h', label: '5 小时请求', value: usage.requestCount5h, unit: '次' },
    { key: 'requests_7d', label: '7 天请求', value: usage.requestCount7d, unit: '次' },
  ];

  return {
    provider,
    auth: buildAuth(provider),
    officialBrief: OFFICIAL_QUOTA_GUIDES[provider].brief,
    sources: OFFICIAL_QUOTA_GUIDES[provider].sources,
    compactCards,
    latestUsage: {
      inputTokens: usage.latestInputTokens,
      outputTokens: usage.latestOutputTokens,
      cachedTokens: usage.latestCachedTokens,
      totalTokens: usage.latestTotalTokens,
      updatedAt: usage.latestAt,
    },
    totals: {
      inputTokens: usage.inputTokensTotal,
      outputTokens: usage.outputTokensTotal,
      cachedTokens: usage.cachedTokensTotal,
      totalTokens: usage.totalTokensTotal,
      requestCountToday: usage.requestCountToday,
      requestCount5h: usage.requestCount5h,
      requestCount7d: usage.requestCount7d,
      limitedCount7d: usage.limitedCount7d,
      totalRequests: usage.totalRequests,
    },
    window: windowInfo,
    remaining,
    latestLimitMessage: latestLimit ? latestLimit.detail : null,
    geminiProject: provider === 'gemini' ? buildGeminiProjectHint() : null,
    updatedAt: new Date().toISOString(),
  };
}

function buildAllQuotaSnapshots(store, providers) {
  const snapshots = {};

  for (const provider of providers) {
    snapshots[provider] = buildQuotaSnapshot(store, provider);
  }

  return snapshots;
}

module.exports = {
  buildAllQuotaSnapshots,
  buildQuotaSnapshot,
};
