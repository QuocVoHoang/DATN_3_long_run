import { PROFILE_COLUMNS } from './profiling.js';
import { DATA_COST_COLUMNS, DATA_COST_LABELS } from './data_cost.js';
export const SCHEMA_VERSION = 6;
export function formatCsvValue(value) {
  if(value == null || (typeof value === 'number' && !Number.isFinite(value))) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function flatten(object, prefix = '', output = {}) {
  for(const [key,value] of Object.entries(object || {})) {
    const path = prefix + key;
    if(value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path+'.', output);
    else output[path] = value;
  }
  return output;
}
export function serializeJson(session) { return JSON.stringify({ ...session, schemaVersion: SCHEMA_VERSION }, null, 2); }
export function serializeCsv(session, kind = 'overall') {
  const records = kind === 'windows' ? session.windows : session.results;
  const common = { schemaVersion: SCHEMA_VERSION, sessionStatus: session.status, sessionPhase: session.phase ?? null, sessionErrorCode: session.errorCode ?? null,
    sessionErrorMessage: session.errorMessage ?? null, createdAt: session.createdAt, config: session.config };
  const rows = (records.length ? records : kind === 'windows' ? [] : [{}]).map(record => flatten({ ...common, ...record }));
  const headers = [...new Set(['schemaVersion','sessionStatus','sessionErrorCode','sessionErrorMessage','engine','mode','status','errorCode','errorMessage','cleanupStatus','cleanupError',
    'callbackFrames','submittedFrames','completedWithinWindow','completedAfterDeadline','failedFrames','unconfirmedFrames','notSubmittedFrames',
    ...DATA_COST_COLUMNS, ...Object.keys(DATA_COST_LABELS), ...PROFILE_COLUMNS, ...rows.flatMap(Object.keys)])];
  const quote = value => '"'+formatCsvValue(value).replaceAll('"','""')+'"';
  return [headers.map(quote).join(','), ...rows.map(row=>headers.map(key=>quote(row[key])).join(','))].join('\r\n')+'\r\n';
}
