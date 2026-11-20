const { z } = require('zod');

const browserKey = Symbol('Bridge browser endpoint');
const port = z.number().int().min(1).max(65535).default(9220);
const webUrl = z.string().max(8192).refine(isWebUrl, '需提供 HTTP 或 HTTPS 地址');
const strict = (shape) => z.strictObject(shape);
const connection = z.discriminatedUnion('action', [
  strict({ action: z.literal('list'), port }),
  strict({
    action: z.literal('connect'), port, targetId: z.string().min(1).max(500),
    url: webUrl.optional(), title: z.string().max(1000).optional(),
  }),
  strict({ action: z.literal('adopt'), port, url: webUrl.optional() }),
  strict({ action: z.literal('status') }),
  strict({ action: z.literal('disconnect') }),
]);
const page = strict({ action: z.literal('status') });
const health = strict({ action: z.literal('health') });
const activate = strict({
  action: z.literal('activate'),
  profile: z.enum(['core', 'runtime']).optional(),
  groups: z.tuple([z.literal('runtime')]).optional(),
}).refine(({ profile, groups }) => Boolean(profile) !== Boolean(groups), '请选择 profile 或 groups');
const manage = z.discriminatedUnion('action', [
  strict({ action: z.literal('list_groups') }),
  activate,
]);

function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

class BrowserError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function result(run) {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    if (error instanceof BrowserError) {
      const { code, message, details } = error;
      return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
    }
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: { code: 'INVALID_ARGUMENT', message: '参数不符合工具契约',
          details: error.issues.map(({ path, code }) => ({ path, code })) },
      };
    }
    return { ok: false, error: { code: 'EXECUTION_FAILED', message: '操作未完成' } };
  }
}

module.exports = { port, connection, page, health, manage, BrowserError, isWebUrl, normalizedUrl, result, browserKey };
