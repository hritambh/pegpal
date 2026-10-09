import type {
  AdminLiquidView,
  AdminLoginRequest,
  AdminLoginResponse,
  AdminMachineView,
  AdminOverview,
  ApiError,
  CalibrationMeasurementRequest,
  CalibrationRunView,
  ConfirmOrderRequest,
  CreateOrderRequest,
  CreateOrderResponse,
  DispensingEventView,
  LiquidPublicView,
  MachinePublicView,
  MockFaultConfig,
  MockStateView,
  OrderView,
  StartCalibrationRequest,
  UpsertLiquidRequest,
} from '@pegpal/shared';
import { ADMIN_TOKEN_KEY, sessionGet, sessionRemove, sessionSet } from './storage';

/** Error thrown for any non-2xx response, carrying the parsed `ApiError` body. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(body: ApiError) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = body.statusCode;
    this.body = body;
  }

  /** Human-readable message including field details. */
  get detailText(): string {
    const details = this.body.details?.length ? ` (${this.body.details.join('; ')})` : '';
    return `${this.body.message}${details}`;
  }
}

export function toApiError(status: number, statusText: string, body: unknown): ApiError {
  if (body && typeof body === 'object' && typeof (body as ApiError).message === 'string') {
    const b = body as Partial<ApiError> & { message: string | string[] };
    const message = Array.isArray(b.message) ? b.message.join('; ') : b.message;
    return {
      statusCode: typeof b.statusCode === 'number' ? b.statusCode : status,
      error: typeof b.error === 'string' ? b.error : statusText,
      message,
      details: Array.isArray(b.details) ? b.details.map(String) : undefined,
      requestId: typeof b.requestId === 'string' ? b.requestId : undefined,
    };
  }
  if (status === 0) return { statusCode: 0, error: 'Network Error', message: 'Could not reach the server. Check your connection and try again.' };
  return { statusCode: status, error: statusText || 'Error', message: statusText || `Request failed (${status})` };
}

/** Readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.detailText;
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  admin?: boolean;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.admin) {
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError(toApiError(0, '', null));
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    if (opts.admin && res.status === 401) handleAdminUnauthorized();
    throw new ApiRequestError(toApiError(res.status, res.statusText, json));
  }
  return { status: res.status, data: json as T };
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- customer

export const customerApi = {
  getMachine: async (machineId: string) => (await request<MachinePublicView>(`/api/machines/${enc(machineId)}`)).data,
  getLiquids: async (machineId: string) => (await request<LiquidPublicView[]>(`/api/machines/${enc(machineId)}/liquids`)).data,
  createOrder: async (body: CreateOrderRequest, idempotencyKey: string) =>
    (await request<CreateOrderResponse>('/api/orders', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  getOrder: async (orderId: string, signal?: AbortSignal) => (await request<OrderView>(`/api/orders/${enc(orderId)}`, { signal })).data,
  confirmOrder: async (orderId: string, orderToken: string, body: ConfirmOrderRequest) =>
    (await request<OrderView>(`/api/orders/${enc(orderId)}/confirm`, { method: 'POST', body, headers: { 'X-Order-Token': orderToken } })).data,
  /** 200 = cancelled (or already terminal), 202 = stop requested while dispensing. Body may be empty on 202. */
  cancelOrder: (orderId: string, orderToken: string) =>
    request<OrderView | null>(`/api/orders/${enc(orderId)}/cancel`, { method: 'POST', headers: { 'X-Order-Token': orderToken } }),
  orderEventsUrl: (orderId: string) => `/api/orders/${enc(orderId)}/events`,
};

// ---------------------------------------------------------------- admin

export function getAdminToken(): string | null {
  return sessionGet(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  sessionSet(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionRemove(ADMIN_TOKEN_KEY);
}

function handleAdminUnauthorized(): void {
  clearAdminToken();
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin/login')) {
    window.location.assign('/admin/login');
  }
}

const admin = <T>(path: string, opts: Omit<RequestOptions, 'admin'> = {}) => request<T>(path, { ...opts, admin: true }).then((r) => r.data);

export const adminApi = {
  login: async (body: AdminLoginRequest) => (await request<AdminLoginResponse>('/api/admin/auth/login', { method: 'POST', body })).data,
  overview: () => admin<AdminOverview>('/api/admin/overview'),
  orders: (params: { machineId?: string; limit?: number } = {}) => admin<OrderView[]>(`/api/admin/orders${query(params)}`),
  events: (params: { machineId?: string; orderId?: string; severity?: string; limit?: number } = {}) =>
    admin<DispensingEventView[]>(`/api/admin/events${query(params)}`),
  setMachineStatus: (id: string, status: 'IN_SERVICE' | 'OUT_OF_SERVICE') =>
    admin<AdminMachineView>(`/api/admin/machines/${enc(id)}`, { method: 'PATCH', body: { status } }),
  stopMachine: (id: string, reason: string) => admin<AdminMachineView>(`/api/admin/machines/${enc(id)}/stop`, { method: 'POST', body: { reason } }),
  clearFault: (id: string, note: string) => admin<AdminMachineView>(`/api/admin/machines/${enc(id)}/clear-fault`, { method: 'POST', body: { note } }),
  liquids: (machineId: string) => admin<AdminLiquidView[]>(`/api/admin/machines/${enc(machineId)}/liquids`),
  createLiquid: (machineId: string, body: UpsertLiquidRequest) =>
    admin<AdminLiquidView>(`/api/admin/machines/${enc(machineId)}/liquids`, { method: 'POST', body }),
  updateLiquid: (liquidId: string, body: Partial<UpsertLiquidRequest>) =>
    admin<AdminLiquidView>(`/api/admin/liquids/${enc(liquidId)}`, { method: 'PATCH', body }),
  calibrationRuns: (params: { liquidId?: string; limit?: number } = {}) =>
    admin<CalibrationRunView[]>(`/api/admin/calibration/runs${query(params)}`),
  startCalibration: (body: StartCalibrationRequest) => admin<CalibrationRunView>('/api/admin/calibration/runs', { method: 'POST', body }),
  calibrationRun: (id: string) => admin<CalibrationRunView>(`/api/admin/calibration/runs/${enc(id)}`),
  submitMeasurement: (id: string, body: CalibrationMeasurementRequest) =>
    admin<CalibrationRunView>(`/api/admin/calibration/runs/${enc(id)}/measurement`, { method: 'POST', body }),
  applyCalibration: (id: string) => admin<AdminLiquidView>(`/api/admin/calibration/runs/${enc(id)}/apply`, { method: 'POST' }),
  mockState: (machineId: string) => admin<MockStateView>(`/api/admin/mock/${enc(machineId)}`),
  mockConfig: (machineId: string, body: Partial<MockFaultConfig>) =>
    admin<MockStateView>(`/api/admin/mock/${enc(machineId)}/config`, { method: 'PUT', body }),
  mockEstop: (machineId: string, active: boolean) => admin<MockStateView>(`/api/admin/mock/${enc(machineId)}/estop`, { method: 'POST', body: { active } }),
  mockConnection: (machineId: string, connected: boolean) =>
    admin<MockStateView>(`/api/admin/mock/${enc(machineId)}/connection`, { method: 'POST', body: { connected } }),
};
