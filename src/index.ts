import { handleGmailSyncModule } from "./modules/gmail-sync"
import { handleInstancesModule } from "./modules/instances"
import { handlePaymentsModule } from "./modules/payments"
import { handleTemplatesModule } from "./modules/templates"
import { handleTranslationsModule } from "./modules/translations"
import { handleUpdateModule } from "./modules/update"

export interface Env {
  DB: D1Database
  ASSETS: R2Bucket
  AI: Ai
  PUBLIC_BASE_URL?: string
  OWNER_API_KEY?: string
  CUSTOM_API_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PUBLISHABLE_KEY?: string
  DEFAULT_COMMISSION_PERCENT?: string
}

type LocalizedText = { fr: string, en: string }
type ReleaseRegistryMeta = {
  name?: string
  description?: string
  icon?: string
  image?: string
  changelogMarkdown?: string
}

type TemplateAssetReference = {
  id?: string
  downloadUrl?: string
  publicUrl?: string
  sourceUrl?: string
}

type TemplateSnapshot = {
  assetManifest?: TemplateAssetReference[]
}

type RegistryCapabilities = {
  authenticated: boolean
  canManageSystemTemplates: boolean
  canManageCustomTemplates: boolean
  tokenLabel: string | null
  registryScope: 'system' | 'custom' | 'shared' | null
}

type PaymentProvider = 'none' | 'stripe_connect'
type PaymentStatus = 'UNPAID' | 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED'
type RegistryPaymentSettings = {
  provider: PaymentProvider
  connectedAccountId: string
  connectedAccountLabel: string
  commissionPercent: number
  automaticTaxEnabled: boolean
  defaultTaxBehavior: 'inclusive' | 'exclusive'
  defaultTaxCode: string
}

type RegistryPaymentLineItem = {
  name: string
  amount: number
  quantity?: number
  currency?: string
  description?: string
  imageUrl?: string
  taxBehavior?: 'inclusive' | 'exclusive'
  taxCode?: string
}

type RegistryPaymentRecord = {
  id: string
  instanceSlug: string
  orderId: string
  orderNumber: string | null
  provider: string
  providerAccountId: string | null
  providerSessionId: string | null
  providerPaymentIntentId: string | null
  providerPaymentStatus: string | null
  paymentStatus: PaymentStatus
  checkoutUrl: string | null
  amountTotal: number
  currency: string
  commissionAmount: number
  commissionPercent: number
  customerEmail: string | null
  successUrl: string | null
  cancelUrl: string | null
  metadata: Record<string, any>
  lastEventId: string | null
  failureReason: string | null
  createdAt: string
  updatedAt: string
}

type TranslationInput = {
  text: string
  sourceLocale: string
  targetLocale: string
}

type TranslationBatchRequest = {
  items: TranslationInput[]
}

type TranslationBatchItemResult = {
  sourceLocale: string
  targetLocale: string
  sourceText: string
  translatedText: string
  cached: boolean
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  })
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("")
}

function getOwnerApiKey(env: Env) {
  return env.OWNER_API_KEY?.trim() || ''
}

function getCustomApiKey(env: Env) {
  return env.CUSTOM_API_KEY?.trim() || ''
}

function readBearerToken(request: Request) {
  const header = request.headers.get('authorization') || ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
}

function getCapabilitiesFromToken(token: string, env: Env): RegistryCapabilities {
  const ownerToken = getOwnerApiKey(env)
  if (token && ownerToken && token === ownerToken) {
    return {
      authenticated: true,
      canManageSystemTemplates: true,
      canManageCustomTemplates: true,
      tokenLabel: 'owner',
      registryScope: 'shared'
    }
  }

  const customToken = getCustomApiKey(env)
  if (token && customToken && token === customToken) {
    return {
      authenticated: true,
      canManageSystemTemplates: false,
      canManageCustomTemplates: true,
      tokenLabel: 'custom',
      registryScope: 'custom'
    }
  }

  return {
    authenticated: false,
    canManageSystemTemplates: false,
    canManageCustomTemplates: false,
    tokenLabel: null,
    registryScope: null
  }
}

function parseCookies(request: Request) {
  const header = request.headers.get('cookie') || ''
  const entries = header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=')
      if (separator === -1) return [part, '']
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]
    })
  return Object.fromEntries(entries) as Record<string, string>
}

function isOwnerSession(request: Request, env: Env) {
  const cookie = parseCookies(request).modula_registry_owner_session || ''
  return Boolean(cookie && cookie === getOwnerApiKey(env))
}

function requireOwnerSession(request: Request, env: Env) {
  if (!isOwnerSession(request, env)) {
    throw new Response('Unauthorized', { status: 401 })
  }
}

function redirect(location: string, init: ResponseInit = {}) {
  return new Response(null, {
    ...init,
    status: init.status || 302,
    headers: {
      location,
      ...(init.headers || {})
    }
  })
}

function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers || {})
    }
  })
}

function baseUrl(env: Env, request: Request) {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '')
}

function templateAssetPublicUrl(env: Env, request: Request, id: string) {
  return `${baseUrl(env, request)}/public/template-assets/${encodeURIComponent(id)}`
}

function templateAssetPublicUrlFromReference(env: Env, request: Request, asset: TemplateAssetReference) {
  const explicitPublicUrl = asset.publicUrl?.trim()
  if (explicitPublicUrl) return explicitPublicUrl

  const assetId = asset.id?.trim()
  if (assetId) {
    return templateAssetPublicUrl(env, request, assetId)
  }

  const downloadUrl = asset.downloadUrl?.trim() || ''
  const match = downloadUrl.match(/\/v1\/template-assets\/([^/]+)\/download$/)
  if (match) {
    return templateAssetPublicUrl(env, request, decodeURIComponent(match[1]!))
  }

  return ''
}

async function resolveTemplateAssetBySourceUrl(
  env: Env,
  sourceUrl: string
) {
  const normalized = (sourceUrl || '').trim()
  if (!normalized) return null

  const row = await env.DB.prepare(
    'SELECT id, source_url FROM template_assets WHERE source_url = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(normalized).first<any>()

  if (!row?.id) {
    return null
  }

  return {
    id: row.id as string,
    sourceUrl: row.source_url as string
  }
}

async function normalizeTemplatePreviewImage(
  env: Env,
  request: Request,
  previewImage: string | null | undefined,
  snapshot?: TemplateSnapshot | null
) {
  const value = (previewImage || '').trim()
  if (!value) return ''

  const legacyMatch = value.match(/\/v1\/template-assets\/([^/]+)\/download$/)
  if (legacyMatch) {
    return templateAssetPublicUrl(env, request, decodeURIComponent(legacyMatch[1]!))
  }

  const normalizedValue = value.replace(/^https?:\/\/[^/]+/i, '')
  if (normalizedValue.startsWith('/site-templates/')) {
    const asset = (snapshot?.assetManifest || []).find((entry) => {
      const sourceUrl = (entry.sourceUrl || '').trim()
      return sourceUrl === normalizedValue || sourceUrl.endsWith(normalizedValue)
    })

    const publicUrl = asset ? templateAssetPublicUrlFromReference(env, request, asset) : ''
    if (publicUrl) {
      return publicUrl
    }

    const resolvedAsset = await resolveTemplateAssetBySourceUrl(env, normalizedValue)
    if (resolvedAsset?.id) {
      return templateAssetPublicUrl(env, request, resolvedAsset.id)
    }
  }

  return value
}

async function authorize(request: Request, env: Env) {
  const capabilities = getCapabilitiesFromToken(readBearerToken(request), env)
  if (!capabilities.authenticated) {
    throw new Response('Unauthorized', { status: 401 })
  }
  return capabilities
}

function getRequestCapabilities(request: Request, env: Env): RegistryCapabilities {
  return getCapabilitiesFromToken(readBearerToken(request), env)
}

function assertTemplateMutationAllowed(capabilities: RegistryCapabilities, sourceType: 'system' | 'custom') {
  if (sourceType === 'system' && !capabilities.canManageSystemTemplates) {
    throw json({ message: 'This token cannot manage system templates.' }, { status: 403 })
  }

  if (sourceType === 'custom' && !capabilities.canManageCustomTemplates) {
    throw json({ message: 'This token cannot manage custom templates.' }, { status: 403 })
  }
}

async function readJson<T>(request: Request) {
  return await request.json() as T
}

function normalizePaymentSettings(value: unknown): RegistryPaymentSettings {
  const input = typeof value === 'object' && value ? value as Partial<RegistryPaymentSettings> : {}
  const commission = Number(input.commissionPercent)
  const fallbackCommission = Number.parseFloat(String(input.commissionPercent ?? '').trim())
  const resolvedCommission = Number.isFinite(commission)
    ? commission
    : Number.isFinite(fallbackCommission)
      ? fallbackCommission
      : 0

  return {
    provider: input.provider === 'stripe_connect' ? 'stripe_connect' : 'none',
    connectedAccountId: typeof input.connectedAccountId === 'string' ? input.connectedAccountId.trim() : '',
    connectedAccountLabel: typeof input.connectedAccountLabel === 'string' ? input.connectedAccountLabel.trim() : '',
    commissionPercent: Math.max(0, Math.min(100, Math.round(resolvedCommission * 100) / 100)),
    automaticTaxEnabled: Boolean(input.automaticTaxEnabled),
    defaultTaxBehavior: input.defaultTaxBehavior === 'exclusive' ? 'exclusive' : 'inclusive',
    defaultTaxCode: typeof input.defaultTaxCode === 'string' ? input.defaultTaxCode.trim() : ''
  }
}

function getDefaultCommissionPercent(env: Env) {
  const value = Number.parseFloat((env.DEFAULT_COMMISSION_PERCENT || '').trim())
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 100) / 100)) : 0
}

function getDefaultPaymentSettings(env: Env): RegistryPaymentSettings {
  return {
    provider: env.STRIPE_SECRET_KEY?.trim() ? 'stripe_connect' : 'none',
    connectedAccountId: '',
    connectedAccountLabel: '',
    commissionPercent: getDefaultCommissionPercent(env),
    automaticTaxEnabled: false,
    defaultTaxBehavior: 'inclusive',
    defaultTaxCode: ''
  }
}

function isStripeConfigured(env: Env) {
  return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

function getStripeHeaders(env: Env) {
  const secret = env.STRIPE_SECRET_KEY?.trim()
  if (!secret) {
    throw json({ message: 'Stripe Connect is not configured on this registry.' }, { status: 503 })
  }

  return {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/x-www-form-urlencoded'
  }
}

function sanitizeExternalImageUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

function normalizeCurrency(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'eur'
}

function normalizeIntegerAmount(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

function appendStripeParam(params: URLSearchParams, key: string, value: unknown) {
  if (value == null) return
  if (typeof value === 'string') {
    if (!value.trim()) return
    params.set(key, value)
    return
  }
  params.set(key, String(value))
}

async function stripeRequest<T>(env: Env, path: string, params: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: getStripeHeaders(env),
    body: params.toString()
  })

  const payload = await response.json<any>()
  if (!response.ok) {
    throw json({
      message: payload?.error?.message || 'Stripe request failed.',
      stripeError: payload?.error || null
    }, { status: response.status })
  }

  return payload as T
}

async function stripeGet<T>(env: Env, path: string, params?: URLSearchParams) {
  const query = params?.toString()
  const response = await fetch(`https://api.stripe.com${path}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY?.trim() || ''}`
    }
  })

  const payload = await response.json<any>()
  if (!response.ok) {
    throw json({
      message: payload?.error?.message || 'Stripe request failed.',
      stripeError: payload?.error || null
    }, { status: response.status })
  }

  return payload as T
}

function stripeHexToBytes(value: string) {
  if (!value || value.length % 2 !== 0) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16)
    if (!Number.isFinite(byte)) return null
    bytes[index / 2] = byte
  }
  return bytes
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!
  }
  return diff === 0
}

async function stripeWebhookEvent(env: Env, rawBody: string, signature: string) {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!secret) {
    throw json({ message: 'Stripe webhook secret is not configured on this registry.' }, { status: 503 })
  }

  const parts = signature.split(',').map(part => part.trim()).filter(Boolean)
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2) || ''
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3)).filter(Boolean)
  if (!timestamp || !signatures.length) {
    throw json({ message: 'Invalid Stripe signature header.' }, { status: 400 })
  }

  const signedPayload = `${timestamp}.${rawBody}`
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedPayload)))
  const matched = signatures.some((candidate) => {
    const bytes = stripeHexToBytes(candidate)
    return bytes ? timingSafeEqual(digest, bytes) : false
  })

  if (!matched) {
    throw json({ message: 'Invalid Stripe webhook signature.' }, { status: 400 })
  }

  return JSON.parse(rawBody) as any
}

function parseInstancePaymentSettings(row: any, env: Env) {
  return normalizePaymentSettings(row?.payment_settings_json ? parseJson(row.payment_settings_json, {}) : getDefaultPaymentSettings(env))
}

function decorateInstance(row: any, env: Env) {
  const paymentSettings = parseInstancePaymentSettings(row, env)
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    environment: row.environment,
    releaseChannel: row.release_channel,
    currentVersion: row.current_version,
    lastSeenAt: row.last_seen_at,
    payment: {
      provider: paymentSettings.provider,
      configured: paymentSettings.provider === 'stripe_connect' && Boolean(paymentSettings.connectedAccountId) && isStripeConfigured(env),
      connectedAccountId: paymentSettings.connectedAccountId,
      connectedAccountLabel: paymentSettings.connectedAccountLabel,
      commissionPercent: paymentSettings.commissionPercent,
      automaticTaxEnabled: paymentSettings.automaticTaxEnabled,
      defaultTaxBehavior: paymentSettings.defaultTaxBehavior,
      defaultTaxCode: paymentSettings.defaultTaxCode,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY?.trim() || ''
    }
  }
}

function paymentRowToRecord(row: any): RegistryPaymentRecord {
  return {
    id: row.id,
    instanceSlug: row.instance_slug,
    orderId: row.order_id,
    orderNumber: row.order_number ?? null,
    provider: row.provider,
    providerAccountId: row.provider_account_id ?? null,
    providerSessionId: row.provider_session_id ?? null,
    providerPaymentIntentId: row.provider_payment_intent_id ?? null,
    providerPaymentStatus: row.provider_payment_status ?? null,
    paymentStatus: row.payment_status,
    checkoutUrl: row.checkout_url ?? null,
    amountTotal: Number(row.amount_total || 0),
    currency: row.currency || 'eur',
    commissionAmount: Number(row.commission_amount || 0),
    commissionPercent: Number(row.commission_percent || 0),
    customerEmail: row.customer_email ?? null,
    successUrl: row.success_url ?? null,
    cancelUrl: row.cancel_url ?? null,
    metadata: parseJson(row.metadata_json, {}),
    lastEventId: row.last_event_id ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function listTemplateVersions(env: Env, templateId: string) {
  const result = await env.DB.prepare(
    'SELECT id, version_number, status, created_at FROM template_versions WHERE template_id = ? ORDER BY version_number ASC'
  ).bind(templateId).all<any>()

  return result.results.map(row => ({
    id: row.id,
    versionNumber: row.version_number,
    status: row.status,
    createdAt: row.created_at
  }))
}

async function rowToTemplate(env: Env, request: Request, row: any) {
  const versions = await listTemplateVersions(env, row.id)
  const currentVersion = row.current_version_id
    ? await env.DB.prepare('SELECT snapshot_json, version_number FROM template_versions WHERE id = ?').bind(row.current_version_id).first<any>()
    : null
  const snapshot = currentVersion ? parseJson<TemplateSnapshot | null>(currentVersion.snapshot_json, null) : null

  return {
    id: row.id,
    slug: row.slug,
    label: parseJson<LocalizedText>(row.label_json, { fr: row.slug, en: row.slug }),
    description: parseJson<LocalizedText>(row.description_json, { fr: '', en: '' }),
    icon: row.icon,
    previewImage: await normalizeTemplatePreviewImage(env, request, row.preview_image, snapshot),
    highlights: parseJson<LocalizedText[]>(row.highlights_json, []),
    themeNames: parseJson<string[]>(row.theme_names_json, []),
    sourceType: row.source_type,
    deletedAt: row.deleted_at,
    currentVersionId: row.current_version_id,
    currentVersionNumber: currentVersion?.version_number ?? null,
    snapshot,
    versions
  }
}

function parseReleaseMeta(manifest: Record<string, any>) {
  return parseJson<ReleaseRegistryMeta>(JSON.stringify(manifest?.registryMeta || {}), {})
}

function decorateRelease(request: Request, env: Env, row: any) {
  const manifest = parseJson<Record<string, any>>(row.manifest_json, {})
  const registryMeta = parseReleaseMeta(manifest)
  return {
    id: row.id,
    version: row.version,
    channel: row.channel,
    checksum: row.checksum,
    artifactKey: row.artifact_key,
    artifactUrl: `${baseUrl(env, request)}/v1/releases/${encodeURIComponent(row.version)}/artifact`,
    manifest,
    createdAt: row.created_at,
    name: registryMeta.name || row.version,
    description: registryMeta.description || '',
    icon: registryMeta.icon || '',
    image: registryMeta.image || '',
    changelogMarkdown: registryMeta.changelogMarkdown || ''
  }
}

async function listTemplates(request: Request, env: Env) {
  const result = await env.DB.prepare('SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY updated_at DESC').all<any>()
  const templates = await Promise.all(result.results.map(row => rowToTemplate(env, request, row)))
  return json(templates)
}

async function getTemplate(request: Request, env: Env, slug: string) {
  const row = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!row) return json({ message: 'Template not found' }, { status: 404 })
  return json(await rowToTemplate(env, request, row))
}

async function createTemplate(request: Request, env: Env, capabilities: RegistryCapabilities) {
  const body = await readJson<any>(request)
  const id = newId('tpl')
  const versionId = newId('tplver')
  const now = nowIso()
  const sourceType = body.sourceType === 'system' ? 'system' : 'custom'
  assertTemplateMutationAllowed(capabilities, sourceType)
  const labelJson = JSON.stringify(body.label || { fr: body.slug, en: body.slug })
  const descriptionJson = JSON.stringify(body.description || { fr: '', en: '' })
  const icon = body.icon || 'mdi:view-dashboard-edit-outline'
  const previewImage = body.previewImage || ''
  const highlightsJson = JSON.stringify(body.highlights || [])
  const themeNamesJson = JSON.stringify(body.themeNames || [])
  const existing = await env.DB.prepare('SELECT * FROM templates WHERE slug = ?').bind(body.slug).first<any>()

  if (existing?.id && !existing.deleted_at) {
    return json({
      message: `Template slug "${body.slug}" already exists. Choose another slug.`
    }, { status: 409 })
  }

  if (existing?.id && existing.deleted_at) {
    const versionCount = await env.DB.prepare(
      'SELECT MAX(version_number) as maxVersion FROM template_versions WHERE template_id = ?'
    ).bind(existing.id).first<any>()
    const nextVersion = Number(versionCount?.maxVersion || 0) + 1

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO template_versions
        (id, template_id, version_number, status, snapshot_json, label_json, description_json, icon, preview_image, highlights_json, theme_names_json, created_at)
        VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        versionId,
        existing.id,
        nextVersion,
        JSON.stringify(body.snapshot || null),
        labelJson,
        descriptionJson,
        icon,
        previewImage,
        highlightsJson,
        themeNamesJson,
        now
      ),
      env.DB.prepare(
        "UPDATE template_versions SET status = 'archived' WHERE template_id = ? AND status = 'published' AND id != ?"
      ).bind(existing.id, versionId),
      env.DB.prepare(
        `UPDATE templates
         SET label_json = ?, description_json = ?, icon = ?, preview_image = ?, highlights_json = ?, theme_names_json = ?,
             source_type = ?, current_version_id = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(
        labelJson,
        descriptionJson,
        icon,
        previewImage,
        highlightsJson,
        themeNamesJson,
        sourceType,
        versionId,
        now,
        existing.id
      )
    ])

    const restored = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(existing.id).first<any>()
    return json(await rowToTemplate(env, request, restored), { status: 201 })
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO templates
        (id, slug, label_json, description_json, icon, preview_image, highlights_json, theme_names_json, source_type, current_version_id, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).bind(
        id,
        body.slug,
        labelJson,
        descriptionJson,
        icon,
        previewImage,
        highlightsJson,
        themeNamesJson,
        sourceType,
        versionId,
        now,
        now
      ),
      env.DB.prepare(
        `INSERT INTO template_versions
        (id, template_id, version_number, status, snapshot_json, label_json, description_json, icon, preview_image, highlights_json, theme_names_json, created_at)
        VALUES (?, ?, 1, 'published', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(versionId, id, JSON.stringify(body.snapshot || null), labelJson, descriptionJson, icon, previewImage, highlightsJson, themeNamesJson, now)
    ])
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (message.includes('UNIQUE constraint failed: templates.slug')) {
      return json({
        message: `Template slug "${body.slug}" already exists. Choose another slug.`
      }, { status: 409 })
    }
    throw error
  }

  const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first<any>()
  return json(await rowToTemplate(env, request, row), { status: 201 })
}

async function createTemplateVersion(request: Request, env: Env, slug: string, capabilities: RegistryCapabilities) {
  const body = await readJson<any>(request)
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })
  assertTemplateMutationAllowed(capabilities, template.source_type === 'system' ? 'system' : 'custom')

  const versionCount = await env.DB.prepare('SELECT MAX(version_number) as maxVersion FROM template_versions WHERE template_id = ?').bind(template.id).first<any>()
  const nextVersion = Number(versionCount?.maxVersion || 0) + 1
  const versionId = newId('tplver')
  const now = nowIso()
  const labelJson = JSON.stringify(body.label || parseJson<LocalizedText>(template.label_json, { fr: template.slug, en: template.slug }))
  const descriptionJson = JSON.stringify(body.description || parseJson<LocalizedText>(template.description_json, { fr: '', en: '' }))
  const icon = body.icon || template.icon
  const previewImage = body.previewImage ?? template.preview_image
  const highlightsJson = JSON.stringify(body.highlights || parseJson(template.highlights_json, []))
  const themeNamesJson = JSON.stringify(body.themeNames || parseJson(template.theme_names_json, []))

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO template_versions
      (id, template_id, version_number, status, snapshot_json, label_json, description_json, icon, preview_image, highlights_json, theme_names_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(versionId, template.id, nextVersion, 'draft', JSON.stringify(body.snapshot || null), labelJson, descriptionJson, icon, previewImage, highlightsJson, themeNamesJson, now),
    env.DB.prepare(
      'UPDATE templates SET label_json = ?, description_json = ?, icon = ?, preview_image = ?, highlights_json = ?, theme_names_json = ?, updated_at = ? WHERE id = ?'
    ).bind(
      labelJson,
      descriptionJson,
      icon,
      previewImage,
      highlightsJson,
      themeNamesJson,
      now,
      template.id
    )
  ])

  const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(template.id).first<any>()
  return json(await rowToTemplate(env, request, row))
}

async function publishTemplateVersion(request: Request, env: Env, slug: string, versionId: string, capabilities: RegistryCapabilities) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })
  assertTemplateMutationAllowed(capabilities, template.source_type === 'system' ? 'system' : 'custom')
  const version = await env.DB.prepare('SELECT * FROM template_versions WHERE id = ? AND template_id = ?').bind(versionId, template.id).first<any>()
  if (!version) return json({ message: 'Version not found' }, { status: 404 })

  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare("UPDATE template_versions SET status = 'archived' WHERE template_id = ? AND status = 'published'").bind(template.id),
    env.DB.prepare("UPDATE template_versions SET status = 'published' WHERE id = ?").bind(versionId),
    env.DB.prepare(
      'UPDATE templates SET current_version_id = ?, label_json = ?, description_json = ?, icon = ?, preview_image = ?, highlights_json = ?, theme_names_json = ?, updated_at = ? WHERE id = ?'
    ).bind(
      versionId,
      version.label_json || template.label_json,
      version.description_json || template.description_json,
      version.icon || template.icon,
      version.preview_image ?? template.preview_image,
      version.highlights_json || template.highlights_json,
      version.theme_names_json || template.theme_names_json,
      now,
      template.id
    )
  ])

  const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(template.id).first<any>()
  return json(await rowToTemplate(env, request, row))
}

async function deleteTemplateVersion(request: Request, env: Env, slug: string, versionId: string, capabilities: RegistryCapabilities) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })
  assertTemplateMutationAllowed(capabilities, template.source_type === 'system' ? 'system' : 'custom')

  const version = await env.DB.prepare('SELECT * FROM template_versions WHERE id = ? AND template_id = ?').bind(versionId, template.id).first<any>()
  if (!version) return json({ message: 'Version not found' }, { status: 404 })
  if (version.status !== 'draft') {
    return json({ message: 'Only draft versions can be deleted' }, { status: 409 })
  }

  const publishedVersion = template.current_version_id
    ? await env.DB.prepare('SELECT * FROM template_versions WHERE id = ? AND template_id = ?').bind(template.current_version_id, template.id).first<any>()
    : null
  const now = nowIso()

  await env.DB.batch([
    env.DB.prepare('DELETE FROM template_versions WHERE id = ? AND template_id = ?').bind(versionId, template.id),
    env.DB.prepare(
      'UPDATE templates SET label_json = ?, description_json = ?, icon = ?, preview_image = ?, highlights_json = ?, theme_names_json = ?, updated_at = ? WHERE id = ?'
    ).bind(
      publishedVersion?.label_json || template.label_json,
      publishedVersion?.description_json || template.description_json,
      publishedVersion?.icon || template.icon,
      publishedVersion?.preview_image ?? template.preview_image,
      publishedVersion?.highlights_json || template.highlights_json,
      publishedVersion?.theme_names_json || template.theme_names_json,
      now,
      template.id
    )
  ])

  const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(template.id).first<any>()
  return json(await rowToTemplate(env, request, row))
}

async function deleteTemplate(env: Env, slug: string, capabilities: RegistryCapabilities) {
  const template = await env.DB.prepare('SELECT source_type FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ ok: true })
  assertTemplateMutationAllowed(capabilities, template.source_type === 'system' ? 'system' : 'custom')
  await env.DB.prepare('UPDATE templates SET deleted_at = ?, updated_at = ? WHERE slug = ?').bind(nowIso(), nowIso(), slug).run()
  return json({ ok: true })
}

async function createTemplateAsset(request: Request, env: Env) {
  const body = await readJson<any>(request)
  const id = newId('asset')
  const storageKey = `template-assets/${id}/${body.filename}`
  const bytes = Uint8Array.from(atob(body.dataBase64), char => char.charCodeAt(0))

  await env.ASSETS.put(storageKey, bytes, {
    httpMetadata: {
      contentType: body.contentType || 'application/octet-stream'
    }
  })

  const now = nowIso()
  await env.DB.prepare(
    'INSERT INTO template_assets (id, filename, content_type, size, checksum, storage_key, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, body.filename, body.contentType || 'application/octet-stream', bytes.byteLength, body.checksum || '', storageKey, body.sourceUrl || '', now).run()

  return json({
    id,
    filename: body.filename,
    contentType: body.contentType || 'application/octet-stream',
    size: bytes.byteLength,
    checksum: body.checksum || '',
    storageKey,
    sourceUrl: body.sourceUrl || '',
    downloadUrl: `${baseUrl(env, request)}/v1/template-assets/${id}/download`,
    publicUrl: templateAssetPublicUrl(env, request, id)
  }, { status: 201 })
}

async function getTemplateAssetBySource(request: Request, env: Env) {
  const url = new URL(request.url)
  const sourceUrl = (url.searchParams.get('sourceUrl') || '').trim()
  if (!sourceUrl) {
    return json({ message: 'sourceUrl is required' }, { status: 400 })
  }

  const row = await env.DB.prepare(
    'SELECT * FROM template_assets WHERE source_url = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(sourceUrl).first<any>()

  if (!row) {
    return json({ message: 'Template asset not found' }, { status: 404 })
  }

  return json({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type || 'application/octet-stream',
    size: Number(row.size || 0),
    checksum: row.checksum || '',
    storageKey: row.storage_key,
    sourceUrl: row.source_url || '',
    downloadUrl: `${baseUrl(env, request)}/v1/template-assets/${encodeURIComponent(row.id)}/download`,
    publicUrl: templateAssetPublicUrl(env, request, row.id)
  })
}

async function downloadTemplateAsset(request: Request, env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM template_assets WHERE id = ?').bind(id).first<any>()
  if (!row) return new Response('Not found', { status: 404 })
  const object = await env.ASSETS.get(row.storage_key)
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(object.body, {
    headers: {
      'content-type': row.content_type,
      'cache-control': 'public, max-age=3600'
    }
  })
}

async function publicTemplateAsset(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM template_assets WHERE id = ?').bind(id).first<any>()
  if (!row) return new Response('Not found', { status: 404 })
  const object = await env.ASSETS.get(row.storage_key)
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(object.body, {
    headers: {
      'content-type': row.content_type || 'application/octet-stream',
      'cache-control': 'public, max-age=3600'
    }
  })
}

async function introspectAuth(request: Request, env: Env) {
  return json(getRequestCapabilities(request, env))
}

async function listReleases(request: Request, env: Env) {
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get('limit') || '10'), 100)
  const offset = Math.max(Number(url.searchParams.get('offset') || '0'), 0)
  const result = await env.DB.prepare('SELECT * FROM releases ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all<any>()
  const totalRow = await env.DB.prepare('SELECT COUNT(*) as total FROM releases').first<any>()
  const items = result.results.map((row) => decorateRelease(request, env, row))
  const total = Number(totalRow?.total || 0)
  return json({
    items,
    total,
    limit,
    offset,
    hasMore: (offset + items.length) < total
  })
}

async function createRelease(request: Request, env: Env) {
  const body = await readJson<any>(request)
  const artifactKey = body.artifactKey || `releases/${body.version}/${body.filename || 'release.tar.gz'}`

  if (body.dataBase64) {
    const bytes = Uint8Array.from(atob(body.dataBase64), char => char.charCodeAt(0))
    await env.ASSETS.put(artifactKey, bytes, {
      httpMetadata: {
        contentType: body.contentType || 'application/gzip'
      }
    })
  }

  const now = nowIso()
  const existing = await env.DB.prepare('SELECT id FROM releases WHERE version = ?').bind(body.version).first<any>()
  if (existing?.id) {
    await env.DB.prepare(
      'UPDATE releases SET channel = ?, checksum = ?, artifact_key = ?, manifest_json = ?, created_at = ? WHERE id = ?'
    ).bind(body.channel || 'stable', body.checksum || '', artifactKey, JSON.stringify(body.manifest || {}), now, existing.id).run()
  } else {
    await env.DB.prepare(
      'INSERT INTO releases (id, version, channel, checksum, artifact_key, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(newId('rel'), body.version, body.channel || 'stable', body.checksum || '', artifactKey, JSON.stringify(body.manifest || {}), now).run()
  }

  return await listReleases(request, env)
}

async function getRelease(request: Request, env: Env, version: string) {
  const row = await env.DB.prepare('SELECT * FROM releases WHERE version = ?').bind(version).first<any>()
  if (!row) return json({ message: 'Release not found' }, { status: 404 })
  return json(decorateRelease(request, env, row))
}

async function downloadReleaseArtifact(env: Env, version: string) {
  const row = await env.DB.prepare('SELECT * FROM releases WHERE version = ?').bind(version).first<any>()
  if (!row) return new Response('Not found', { status: 404 })
  const object = await env.ASSETS.get(row.artifact_key)
  if (!object) return new Response('Not found', { status: 404 })
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${version}.tar.gz"`
    }
  })
}

async function registerInstance(request: Request, env: Env) {
  const body = await readJson<any>(request)
  const now = nowIso()
  const existing = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(body.slug).first<any>()
  const paymentSettings = normalizePaymentSettings(body.payment || {})
  if (existing) {
    await env.DB.prepare(
      'UPDATE instances SET name = ?, environment = ?, release_channel = ?, payment_provider = ?, payment_settings_json = ?, last_seen_at = ?, updated_at = ? WHERE slug = ?'
    ).bind(
      body.name,
      body.environment || 'development',
      body.releaseChannel || 'stable',
      paymentSettings.provider,
      JSON.stringify(paymentSettings),
      now,
      now,
      body.slug
    ).run()
  } else {
    await env.DB.prepare(
      'INSERT INTO instances (id, slug, name, environment, release_channel, current_version, payment_provider, payment_settings_json, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)'
    ).bind(
      newId('inst'),
      body.slug,
      body.name,
      body.environment || 'development',
      body.releaseChannel || 'stable',
      paymentSettings.provider,
      JSON.stringify(paymentSettings),
      now,
      now,
      now
    ).run()
  }
  const row = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(body.slug).first<any>()
  return json(decorateInstance(row, env))
}

async function getInstanceBySlug(env: Env, slug: string) {
  const row = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(slug).first<any>()
  if (!row) {
    throw json({ message: `Instance "${slug}" is not registered.` }, { status: 404 })
  }
  return row
}

async function ensureInstanceExists(env: Env, slug: string) {
  const existing = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(slug).first<any>()
  if (existing) return existing
  const now = nowIso()
  await env.DB.prepare(
    'INSERT INTO instances (id, slug, name, environment, release_channel, current_version, payment_provider, payment_settings_json, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)'
  ).bind(
    newId('inst'),
    slug,
    slug,
    'unknown',
    'stable',
    'none',
    JSON.stringify(getDefaultPaymentSettings(env)),
    now,
    now,
    now
  ).run()
  return await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(slug).first<any>()
}

function getInstanceSlugFromRequest(request: Request) {
  return (request.headers.get('x-instance-slug') || new URL(request.url).searchParams.get('instanceSlug') || '').trim()
}

async function getInstancePaymentConfig(request: Request, env: Env) {
  const instanceSlug = getInstanceSlugFromRequest(request)
  if (!instanceSlug) {
    return json({ message: 'Instance slug is required.' }, { status: 400 })
  }

  const row = await ensureInstanceExists(env, instanceSlug)
  return json(decorateInstance(row, env).payment)
}

async function updateInstancePaymentConfig(request: Request, env: Env) {
  await authorize(request, env)
  const instanceSlug = getInstanceSlugFromRequest(request)
  if (!instanceSlug) {
    return json({ message: 'Instance slug is required.' }, { status: 400 })
  }

  const row = await ensureInstanceExists(env, instanceSlug)
  const body = await readJson<any>(request)
  const mergedSettings = normalizePaymentSettings({
    ...parseInstancePaymentSettings(row, env),
    ...(body || {})
  })
  const now = nowIso()

  await env.DB.prepare(
    'UPDATE instances SET payment_provider = ?, payment_settings_json = ?, updated_at = ? WHERE slug = ?'
  ).bind(
    mergedSettings.provider,
    JSON.stringify(mergedSettings),
    now,
    instanceSlug
  ).run()

  const updated = await getInstanceBySlug(env, instanceSlug)
  return json(decorateInstance(updated, env).payment)
}

async function getPaymentByOrder(env: Env, instanceSlug: string, orderId: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM payments WHERE instance_slug = ? AND order_id = ?'
  ).bind(instanceSlug, orderId).first<any>()
  return row ? paymentRowToRecord(row) : null
}

async function getPaymentBySession(env: Env, providerSessionId: string) {
  const row = await env.DB.prepare(
    'SELECT * FROM payments WHERE provider_session_id = ?'
  ).bind(providerSessionId).first<any>()
  return row ? paymentRowToRecord(row) : null
}

async function persistPaymentRecord(env: Env, record: Partial<RegistryPaymentRecord> & { id: string, instanceSlug: string, orderId: string, provider: string }) {
  const now = nowIso()
  const existing = await env.DB.prepare('SELECT id, created_at FROM payments WHERE id = ?').bind(record.id).first<any>()
  await env.DB.prepare(
    `INSERT OR REPLACE INTO payments (
      id, instance_slug, order_id, order_number, provider, provider_account_id, provider_session_id,
      provider_payment_intent_id, provider_payment_status, payment_status, checkout_url, amount_total,
      currency, commission_amount, commission_percent, customer_email, success_url, cancel_url,
      metadata_json, last_event_id, failure_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    record.id,
    record.instanceSlug,
    record.orderId,
    record.orderNumber || null,
    record.provider,
    record.providerAccountId || null,
    record.providerSessionId || null,
    record.providerPaymentIntentId || null,
    record.providerPaymentStatus || null,
    record.paymentStatus || 'PENDING',
    record.checkoutUrl || null,
    normalizeIntegerAmount(record.amountTotal),
    normalizeCurrency(record.currency),
    normalizeIntegerAmount(record.commissionAmount),
    Number(record.commissionPercent || 0),
    record.customerEmail || null,
    record.successUrl || null,
    record.cancelUrl || null,
    JSON.stringify(record.metadata || {}),
    record.lastEventId || null,
    record.failureReason || null,
    existing?.created_at || now,
    now
  ).run()

  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(record.id).first<any>()
  return paymentRowToRecord(row)
}

async function createStripeConnectCheckout(request: Request, env: Env) {
  await authorize(request, env)
  const instanceSlug = getInstanceSlugFromRequest(request)
  if (!instanceSlug) {
    return json({ message: 'Instance slug is required.' }, { status: 400 })
  }

  const instance = await getInstanceBySlug(env, instanceSlug)
  const paymentSettings = parseInstancePaymentSettings(instance, env)
  if (paymentSettings.provider !== 'stripe_connect' || !paymentSettings.connectedAccountId) {
    return json({ message: 'Stripe Connect is not configured for this instance.' }, { status: 400 })
  }
  if (!isStripeConfigured(env)) {
    return json({ message: 'Stripe Connect is not configured on this registry.' }, { status: 503 })
  }

  const body = await readJson<{
    orderId: string
    orderNumber?: string
    successUrl: string
    cancelUrl: string
    customerEmail?: string
    locale?: string
    currency?: string
    metadata?: Record<string, string>
    lineItems?: RegistryPaymentLineItem[]
  }>(request)

  if (!body.orderId?.trim() || !body.successUrl?.trim() || !body.cancelUrl?.trim()) {
    return json({ message: 'orderId, successUrl and cancelUrl are required.' }, { status: 400 })
  }

  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : []
  if (!lineItems.length) {
    return json({ message: 'At least one line item is required.' }, { status: 400 })
  }

  const currency = normalizeCurrency(body.currency)
  const amountTotal = lineItems.reduce((sum, item) => sum + normalizeIntegerAmount(item.amount) * Math.max(1, Math.round(Number(item.quantity || 1))), 0)
  const commissionPercent = paymentSettings.commissionPercent
  const commissionAmount = Math.max(0, Math.round(amountTotal * (commissionPercent / 100)))
  const SUPPORTED_STRIPE_LOCALES = new Set([
    'da', 'de', 'en', 'es', 'fi', 'fr', 'it', 'ja', 'ko',
    'ms', 'nb', 'nl', 'pt', 'sv', 'th', 'zh', 'zh-hk', 'zh-tw'
  ])
  const locale = (body.locale || '').trim().toLowerCase()
  const stripeLocale = SUPPORTED_STRIPE_LOCALES.has(locale) ? locale : ''

  const params = new URLSearchParams()
  appendStripeParam(params, 'mode', 'payment')
  if (stripeLocale) {
    appendStripeParam(params, 'locale', stripeLocale)
  }
  appendStripeParam(params, 'success_url', body.successUrl.trim())
  appendStripeParam(params, 'cancel_url', body.cancelUrl.trim())
  appendStripeParam(params, 'customer_email', body.customerEmail?.trim() || '')
  appendStripeParam(params, 'payment_intent_data[application_fee_amount]', commissionAmount)
  appendStripeParam(params, 'payment_intent_data[transfer_data][destination]', paymentSettings.connectedAccountId)
  appendStripeParam(params, 'metadata[instanceSlug]', instanceSlug)
  appendStripeParam(params, 'metadata[orderId]', body.orderId.trim())
  appendStripeParam(params, 'metadata[orderNumber]', body.orderNumber?.trim() || '')
  if (paymentSettings.automaticTaxEnabled) {
    appendStripeParam(params, 'automatic_tax[enabled]', 'true')
  }
  Object.entries(body.metadata || {}).forEach(([key, value]) => appendStripeParam(params, `metadata[${key}]`, value))

  for (const [index, item] of lineItems.entries()) {
    const quantity = Math.max(1, Math.round(Number(item.quantity || 1)))
    const imageUrl = sanitizeExternalImageUrl(item.imageUrl)
    const resolvedTaxBehavior = item.taxBehavior === 'exclusive' ? 'exclusive' : item.taxBehavior === 'inclusive' ? 'inclusive' : paymentSettings.defaultTaxBehavior
    const resolvedTaxCode = typeof item.taxCode === 'string' && item.taxCode.trim()
      ? item.taxCode.trim()
      : paymentSettings.defaultTaxCode
    if (paymentSettings.automaticTaxEnabled && !resolvedTaxCode) {
      return json({
        message: 'Stripe Tax est activé mais aucun code taxe n’est défini pour une ligne. Renseignez un code global ou un code par produit/lot.'
      }, { status: 400 })
    }
    appendStripeParam(params, `line_items[${index}][quantity]`, quantity)
    appendStripeParam(params, `line_items[${index}][price_data][currency]`, currency)
    appendStripeParam(params, `line_items[${index}][price_data][unit_amount]`, normalizeIntegerAmount(item.amount))
    if (paymentSettings.automaticTaxEnabled) {
      appendStripeParam(
        params,
        `line_items[${index}][price_data][tax_behavior]`,
        resolvedTaxBehavior
      )
      appendStripeParam(
        params,
        `line_items[${index}][price_data][product_data][tax_code]`,
        resolvedTaxCode
      )
    }
    appendStripeParam(params, `line_items[${index}][price_data][product_data][name]`, item.name)
    appendStripeParam(params, `line_items[${index}][price_data][product_data][description]`, item.description || '')
    appendStripeParam(params, `line_items[${index}][price_data][product_data][images][0]`, imageUrl)
  }

  const stripeSession = await stripeRequest<any>(env, '/v1/checkout/sessions', params)
  const payment = await persistPaymentRecord(env, {
    id: newId('pay'),
    instanceSlug,
    orderId: body.orderId.trim(),
    orderNumber: body.orderNumber?.trim() || null,
    provider: 'stripe_connect',
    providerAccountId: paymentSettings.connectedAccountId,
    providerSessionId: stripeSession.id || null,
    providerPaymentIntentId: typeof stripeSession.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession.payment_intent?.id || null,
    providerPaymentStatus: stripeSession.payment_status || null,
    paymentStatus: stripeSession.payment_status === 'paid' ? 'PAID' : 'PENDING',
    checkoutUrl: stripeSession.url || null,
    amountTotal,
    currency,
    commissionAmount,
    commissionPercent,
    customerEmail: body.customerEmail?.trim() || null,
    successUrl: body.successUrl.trim(),
    cancelUrl: body.cancelUrl.trim(),
    metadata: body.metadata || {}
  })

  return json(payment)
}

async function getPaymentStatusBySession(request: Request, env: Env, sessionId: string) {
  await authorize(request, env)
  let payment = await getPaymentBySession(env, sessionId)
  if (!payment) return json({ message: 'Payment session not found.' }, { status: 404 })

  if (isStripeConfigured(env) && payment.providerSessionId) {
    const stripeSession = await stripeGet<any>(env, `/v1/checkout/sessions/${encodeURIComponent(payment.providerSessionId)}`)
    payment = await persistPaymentRecord(env, {
      ...payment,
      id: payment.id,
      instanceSlug: payment.instanceSlug,
      orderId: payment.orderId,
      provider: payment.provider,
      providerSessionId: payment.providerSessionId,
      providerPaymentIntentId: typeof stripeSession.payment_intent === 'string'
        ? stripeSession.payment_intent
        : payment.providerPaymentIntentId,
      providerPaymentStatus: stripeSession.payment_status || payment.providerPaymentStatus,
      paymentStatus: stripeSession.payment_status === 'paid'
        ? 'PAID'
        : stripeSession.status === 'expired'
          ? 'FAILED'
          : payment.paymentStatus,
      checkoutUrl: stripeSession.url || payment.checkoutUrl,
      metadata: {
        ...payment.metadata,
        stripeCheckoutStatus: stripeSession.status || null
      }
    })
  }

  return json(payment)
}

async function getPaymentStatusByOrder(request: Request, env: Env, orderId: string) {
  await authorize(request, env)
  const instanceSlug = getInstanceSlugFromRequest(request)
  if (!instanceSlug) {
    return json({ message: 'Instance slug is required.' }, { status: 400 })
  }
  const payment = await getPaymentByOrder(env, instanceSlug, orderId)
  if (!payment) return json({ message: 'Payment not found.' }, { status: 404 })
  return json(payment)
}

async function syncStripePaymentRecord(env: Env, payload: any) {
  const eventType = String(payload?.type || '')
  const eventId = String(payload?.id || '')
  const object = payload?.data?.object || {}

  if (eventType.startsWith('checkout.session.')) {
    const providerSessionId = typeof object.id === 'string' ? object.id : ''
    if (!providerSessionId) return null
    const payment = await getPaymentBySession(env, providerSessionId)
    if (!payment) return null

    return await persistPaymentRecord(env, {
      ...payment,
      id: payment.id,
      instanceSlug: payment.instanceSlug,
      orderId: payment.orderId,
      provider: payment.provider,
      providerSessionId,
      providerPaymentIntentId: typeof object.payment_intent === 'string' ? object.payment_intent : payment.providerPaymentIntentId,
      providerPaymentStatus: object.payment_status || payment.providerPaymentStatus,
      paymentStatus: object.payment_status === 'paid'
        ? 'PAID'
        : eventType === 'checkout.session.expired' || eventType === 'checkout.session.async_payment_failed'
          ? 'FAILED'
          : 'PENDING',
      checkoutUrl: object.url || payment.checkoutUrl,
      lastEventId: eventId,
      failureReason: eventType === 'checkout.session.async_payment_failed'
        ? 'async_payment_failed'
        : eventType === 'checkout.session.expired'
          ? 'checkout_session_expired'
          : payment.failureReason,
      metadata: {
        ...payment.metadata,
        stripeCheckoutStatus: object.status || null
      }
    })
  }

  if (eventType.startsWith('payment_intent.')) {
    const providerPaymentIntentId = typeof object.id === 'string' ? object.id : ''
    if (!providerPaymentIntentId) return null
    const row = await env.DB.prepare('SELECT * FROM payments WHERE provider_payment_intent_id = ?').bind(providerPaymentIntentId).first<any>()
    if (!row) return null
    const payment = paymentRowToRecord(row)
    return await persistPaymentRecord(env, {
      ...payment,
      id: payment.id,
      instanceSlug: payment.instanceSlug,
      orderId: payment.orderId,
      provider: payment.provider,
      providerPaymentIntentId,
      providerPaymentStatus: object.status || payment.providerPaymentStatus,
      paymentStatus: eventType === 'payment_intent.succeeded'
        ? 'PAID'
        : eventType === 'payment_intent.payment_failed' || eventType === 'payment_intent.canceled'
          ? 'FAILED'
          : payment.paymentStatus,
      lastEventId: eventId,
      failureReason: object.last_payment_error?.message || payment.failureReason
    })
  }

  if (eventType === 'charge.refunded') {
    const paymentIntentId = typeof object.payment_intent === 'string'
      ? object.payment_intent
      : object.payment_intent?.id || ''
    if (!paymentIntentId) return null
    const row = await env.DB.prepare('SELECT * FROM payments WHERE provider_payment_intent_id = ?').bind(paymentIntentId).first<any>()
    if (!row) return null
    const payment = paymentRowToRecord(row)
    return await persistPaymentRecord(env, {
      ...payment,
      id: payment.id,
      instanceSlug: payment.instanceSlug,
      orderId: payment.orderId,
      provider: payment.provider,
      paymentStatus: 'REFUNDED',
      providerPaymentStatus: 'refunded',
      lastEventId: eventId,
      failureReason: null
    })
  }

  return null
}

async function handleStripeWebhook(request: Request, env: Env) {
  const signature = request.headers.get('stripe-signature') || ''
  if (!signature) {
    return json({ message: 'Stripe-Signature header is required.' }, { status: 400 })
  }
  const rawBody = await request.text()
  const event = await stripeWebhookEvent(env, rawBody, signature)
  const payment = await syncStripePaymentRecord(env, event)
  return json({
    ok: true,
    eventId: event?.id || null,
    eventType: event?.type || null,
    payment
  })
}

async function createDeployment(request: Request, env: Env) {
  const body = await readJson<any>(request)
  const id = body.id || newId('dep')
  const now = nowIso()
  const existing = await env.DB.prepare('SELECT id FROM deployment_jobs WHERE id = ?').bind(id).first<any>()
  if (existing?.id) {
    await env.DB.prepare(
      'UPDATE deployment_jobs SET instance_slug = ?, version = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?'
    ).bind(body.instanceSlug, body.version, body.status || 'pending', JSON.stringify(body.metadata || null), now, id).run()
  } else {
    await env.DB.prepare(
      'INSERT INTO deployment_jobs (id, instance_slug, version, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, body.instanceSlug, body.version, body.status || 'pending', JSON.stringify(body.metadata || null), now, now).run()
  }

  const logs = Array.isArray(body.logs) ? body.logs : [{
    id: newId('log'),
    deploymentId: id,
    level: 'info',
    message: 'Deployment job created',
    createdAt: now
  }]

  for (const log of logs) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO deployment_logs (id, deployment_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(log.id || newId('log'), id, log.level || 'info', log.message || '', log.createdAt || now).run()
  }

  return await getDeployment(env, id)
}

async function updateDeployment(request: Request, env: Env, id: string) {
  const body = await readJson<any>(request)
  const existing = await env.DB.prepare('SELECT * FROM deployment_jobs WHERE id = ?').bind(id).first<any>()
  if (!existing) return json({ message: 'Deployment not found' }, { status: 404 })

  const status = body.status || existing.status
  const metadata = body.metadata === undefined ? parseJson(existing.metadata_json, null) : body.metadata
  const updatedAt = nowIso()

  await env.DB.prepare(
    'UPDATE deployment_jobs SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ?'
  ).bind(status, JSON.stringify(metadata || null), updatedAt, id).run()

  if (Array.isArray(body.logs)) {
    for (const log of body.logs) {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO deployment_logs (id, deployment_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(log.id || newId('log'), id, log.level || 'info', log.message || '', log.createdAt || updatedAt).run()
    }
  }

  if (status === 'completed' || status === 'rolled_back') {
    await env.DB.prepare(
      'UPDATE instances SET current_version = ?, last_seen_at = ?, updated_at = ? WHERE slug = ?'
    ).bind(body.version || existing.version, updatedAt, updatedAt, body.instanceSlug || existing.instance_slug).run()
  }

  return await getDeployment(env, id)
}

async function listDeployments(request: Request, env: Env) {
  const url = new URL(request.url)
  const instanceSlug = (url.searchParams.get('instanceSlug') || '').trim()
  const limit = Math.min(Number(url.searchParams.get('limit') || '20'), 100)
  const offset = Math.max(Number(url.searchParams.get('offset') || '0'), 0)
  const query = instanceSlug
    ? 'SELECT id FROM deployment_jobs WHERE instance_slug = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    : 'SELECT id FROM deployment_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?'
  const statement = instanceSlug
    ? env.DB.prepare(query).bind(instanceSlug, limit, offset)
    : env.DB.prepare(query).bind(limit, offset)
  const result = await statement.all<any>()
  const jobs = await Promise.all(result.results.map(row => getDeployment(env, row.id).then(response => response.json())))
  const totalQuery = instanceSlug
    ? env.DB.prepare('SELECT COUNT(*) as total FROM deployment_jobs WHERE instance_slug = ?').bind(instanceSlug)
    : env.DB.prepare('SELECT COUNT(*) as total FROM deployment_jobs')
  const totalRow = await totalQuery.first<any>()
  const total = Number(totalRow?.total || 0)
  return json({
    items: jobs,
    total,
    limit,
    offset,
    hasMore: (offset + jobs.length) < total
  })
}

async function getDeployment(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM deployment_jobs WHERE id = ?').bind(id).first<any>()
  if (!row) return json({ message: 'Deployment not found' }, { status: 404 })
  const logs = await env.DB.prepare('SELECT * FROM deployment_logs WHERE deployment_id = ? ORDER BY created_at ASC').bind(id).all<any>()
  return json({
    id: row.id,
    instanceSlug: row.instance_slug,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata_json, null),
    logs: logs.results.map(log => ({
      id: log.id,
      deploymentId: log.deployment_id,
      level: log.level,
      message: log.message,
      createdAt: log.created_at
    }))
  })
}

function renderAdminLoginPage(message = '') {
  return html(`<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Modula Registry Admin</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: linear-gradient(160deg, #f5f3ff 0%, #eff6ff 100%); color: #1f2937; min-height: 100vh; display: grid; place-items: center; }
      .card { width: min(28rem, calc(100vw - 2rem)); background: rgba(255,255,255,.9); border: 1px solid #dbe4ff; border-radius: 24px; padding: 2rem; box-shadow: 0 20px 50px rgba(99,102,241,.12); }
      h1 { margin: 0 0 .5rem; font-size: 1.8rem; }
      p { margin: 0 0 1.25rem; color: #4b5563; }
      input { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 14px; padding: .9rem 1rem; font: inherit; }
      button { margin-top: 1rem; width: 100%; border: 0; border-radius: 14px; padding: .95rem 1rem; background: #4f46e5; color: white; font: inherit; font-weight: 600; cursor: pointer; }
      .error { margin-top: 1rem; color: #b91c1c; font-size: .95rem; }
    </style>
  </head>
  <body>
    <form class="card" method="post" action="/admin/login">
      <h1>Modula Registry</h1>
      <p>Accès propriétaire au registre central.</p>
      <input type="password" name="token" placeholder="Clé owner" autocomplete="current-password" />
      <button type="submit">Ouvrir l’administration</button>
      ${message ? `<div class="error">${message}</div>` : ''}
    </form>
  </body>
</html>`)
}

function renderAdminAppPage() {
  return html(`<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Modula Registry Admin</title>
    <style>
      :root { color-scheme: light; --bg:#f8fafc; --panel:#ffffff; --line:#dbe4ff; --text:#1f2937; --muted:#64748b; --accent:#4f46e5; }
      * { box-sizing: border-box; }
      body { margin:0; font-family:"Segoe UI",sans-serif; background: radial-gradient(circle at top left,#eef2ff,transparent 30%), linear-gradient(180deg,#f8fafc,#eef2ff); color:var(--text); }
      header { padding: 1.5rem 2rem; display:flex; justify-content:space-between; align-items:center; gap:1rem; }
      h1,h2,h3 { margin:0; }
      main { padding: 0 2rem 2rem; display:grid; gap:1.5rem; }
      .grid { display:grid; gap:1.5rem; grid-template-columns: 1.05fr .95fr; }
      .panel { background:rgba(255,255,255,.92); border:1px solid var(--line); border-radius:24px; padding:1.25rem; box-shadow: 0 14px 40px rgba(79,70,229,.08); }
      .list { display:grid; gap:.75rem; max-height:65vh; overflow:auto; padding-right:.25rem; }
      .item { border:1px solid var(--line); border-radius:18px; background:#fff; padding:1rem; cursor:pointer; }
      .item.active { border-color:var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background:#eef2ff; }
      .meta { color:var(--muted); font-size:.9rem; margin-top:.25rem; }
      label { display:grid; gap:.35rem; font-size:.92rem; color:var(--muted); }
      input, textarea { width:100%; font:inherit; color:var(--text); border:1px solid #cbd5e1; border-radius:14px; padding:.8rem .95rem; background:#fff; }
      textarea { min-height: 110px; resize: vertical; }
      .row { display:grid; gap:.9rem; grid-template-columns: 1fr 1fr; }
      .actions { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:1rem; }
      button { border:0; border-radius:14px; padding:.85rem 1rem; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
      button.secondary { background:#e2e8f0; color:#0f172a; }
      .badge { display:inline-flex; align-items:center; gap:.4rem; border-radius:999px; background:#eef2ff; color:#3730a3; padding:.25rem .65rem; font-size:.78rem; font-weight:700; }
      .status { color:var(--muted); font-size:.95rem; min-height:1.4rem; }
      form.inline { margin:0; }
      @media (max-width: 980px) { .grid, .row { grid-template-columns: 1fr; } header, main { padding-left:1rem; padding-right:1rem; } }
    </style>
  </head>
  <body>
    <header>
      <div>
        <div class="badge">Registry Owner</div>
        <h1 style="margin-top:.6rem;">Modula Registry Admin</h1>
      </div>
      <form class="inline" method="post" action="/admin/logout"><button class="secondary" type="submit">Se déconnecter</button></form>
    </header>
    <main>
      <div class="grid">
        <section class="panel">
          <div style="display:flex;justify-content:space-between;gap:1rem;align-items:end;">
            <div>
              <h2>Templates système</h2>
              <div class="meta">Nom, description, icône, image et highlights publiés.</div>
            </div>
            <button class="secondary" id="refresh-templates" type="button">Rafraîchir</button>
          </div>
          <div id="templates-list" class="list" style="margin-top:1rem;"></div>
        </section>
        <section class="panel">
          <h2>Éditer un template</h2>
          <div id="template-status" class="status" style="margin-top:.5rem;"></div>
          <form id="template-form" style="margin-top:1rem;">
            <div class="row">
              <label>Slug<input name="slug" readonly /></label>
              <label>Icône<input name="icon" placeholder="mdi:view-dashboard-outline" /></label>
            </div>
            <div class="row" style="margin-top:.9rem;">
              <label>Nom FR<input name="labelFr" /></label>
              <label>Nom EN<input name="labelEn" /></label>
            </div>
            <label style="margin-top:.9rem;">Description FR<textarea name="descriptionFr"></textarea></label>
            <label style="margin-top:.9rem;">Description EN<textarea name="descriptionEn"></textarea></label>
            <label style="margin-top:.9rem;">Image de preview<input name="previewImage" placeholder="/site-templates/preview-modula.svg" /></label>
            <label style="margin-top:.9rem;">Highlights (un par ligne, format fr | en)<textarea name="highlights"></textarea></label>
            <label style="margin-top:.9rem;">Noms de thèmes (un par ligne)<textarea name="themeNames"></textarea></label>
            <div class="actions"><button type="submit">Enregistrer le template</button></div>
          </form>
        </section>
      </div>
      <div class="grid">
        <section class="panel">
          <div style="display:flex;justify-content:space-between;gap:1rem;align-items:end;">
            <div>
              <h2>Releases</h2>
              <div class="meta">Changelog et présentation visibles par version.</div>
            </div>
            <button class="secondary" id="refresh-releases" type="button">Rafraîchir</button>
          </div>
          <div id="releases-list" class="list" style="margin-top:1rem;"></div>
        </section>
        <section class="panel">
          <h2>Éditer une release</h2>
          <div id="release-status" class="status" style="margin-top:.5rem;"></div>
          <form id="release-form" style="margin-top:1rem;">
            <div class="row">
              <label>Version<input name="version" readonly /></label>
              <label>Canal<input name="channel" readonly /></label>
            </div>
            <div class="row" style="margin-top:.9rem;">
              <label>Nom affiché<input name="name" /></label>
              <label>Icône<input name="icon" placeholder="mdi:package-variant-closed" /></label>
            </div>
            <label style="margin-top:.9rem;">Description<textarea name="description"></textarea></label>
            <label style="margin-top:.9rem;">Image<input name="image" placeholder="https://..." /></label>
            <label style="margin-top:.9rem;">Changelog Markdown<textarea name="changelogMarkdown" style="min-height:220px;"></textarea></label>
            <div class="actions"><button type="submit">Enregistrer la release</button></div>
          </form>
        </section>
      </div>
      <div class="grid">
        <section class="panel">
          <div style="display:flex;justify-content:space-between;gap:1rem;align-items:end;">
            <div>
              <h2>Instances</h2>
              <div class="meta">Configurer Stripe Connect et la commission par instance.</div>
            </div>
            <button class="secondary" id="refresh-instances" type="button">Rafraîchir</button>
          </div>
          <div id="instances-list" class="list" style="margin-top:1rem;"></div>
        </section>
        <section class="panel">
          <h2>Éditer une instance</h2>
          <div id="instance-status" class="status" style="margin-top:.5rem;"></div>
          <form id="instance-form" style="margin-top:1rem;">
            <div class="row">
              <label>Slug<input name="slug" readonly /></label>
              <label>Nom<input name="name" readonly /></label>
            </div>
            <div class="row" style="margin-top:.9rem;">
              <label>Environnement<input name="environment" readonly /></label>
              <label>Canal<input name="releaseChannel" readonly /></label>
            </div>
            <div class="row" style="margin-top:.9rem;">
              <label>Provider
                <input name="provider" placeholder="stripe_connect ou none" />
              </label>
              <label>Commission (%)<input name="commissionPercent" type="number" min="0" max="100" step="0.01" /></label>
            </div>
            <div class="row" style="margin-top:.9rem;">
              <label>Compte connecté Stripe<input name="connectedAccountId" placeholder="acct_..." /></label>
              <label>Libellé compte<input name="connectedAccountLabel" placeholder="Nom de l'instance ou du marchand" /></label>
            </div>
            <div class="actions"><button type="submit">Enregistrer l’instance</button></div>
          </form>
        </section>
      </div>
    </main>
    <script>
      const state = { templates: [], releases: [], instances: [], selectedTemplateSlug: '', selectedReleaseVersion: '', selectedInstanceSlug: '' }
      const $ = (selector) => document.querySelector(selector)
      const templatesList = $('#templates-list')
      const releasesList = $('#releases-list')
      const instancesList = $('#instances-list')
      const templateForm = $('#template-form')
      const releaseForm = $('#release-form')
      const instanceForm = $('#instance-form')
      const templateStatus = $('#template-status')
      const releaseStatus = $('#release-status')
      const instanceStatus = $('#instance-status')

      function text(value) { return value == null ? '' : String(value) }
      function localized(value) { return text(value?.fr || value?.en || '') }
      function encodeHighlights(items) { return (items || []).map(item => text(item?.fr) + ' | ' + text(item?.en)).join('\\n') }
      function parseHighlights(value) {
        return text(value).split(/\\r?\\n/).map(line => line.trim()).filter(Boolean).map((line) => {
          const parts = line.split('|')
          const fr = text(parts[0]).trim()
          const en = text(parts[1]).trim()
          return { fr: fr || '', en: en || fr || '' }
        })
      }
      function encodeThemeNames(items) { return (items || []).join('\\n') }
      function parseThemeNames(value) { return text(value).split(/\\r?\\n/).map(line => line.trim()).filter(Boolean) }

      async function fetchJson(url, options = {}) {
        const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } })
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.message || 'Request failed')
        return data
      }

      function renderTemplates() {
        templatesList.innerHTML = state.templates.map((template) => '<button type="button" class="item ' + (state.selectedTemplateSlug === template.slug ? 'active' : '') + '" data-template-slug="' + template.slug + '"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:start;"><div><strong style="color: black;">' + localized(template.label) + '</strong><div class="meta">' + template.slug + ' · ' + template.sourceType + '</div></div><span class="badge">v' + (template.currentVersionNumber ?? '-') + '</span></div><div class="meta" style="margin-top:.6rem;">' + localized(template.description) + '</div></button>').join('')
        templatesList.querySelectorAll('[data-template-slug]').forEach((button) => {
          button.addEventListener('click', () => {
            state.selectedTemplateSlug = button.getAttribute('data-template-slug') || ''
            fillTemplateForm()
            renderTemplates()
          })
        })
      }

      function renderReleases() {
        releasesList.innerHTML = state.releases.map((release) => '<button type="button" class="item ' + (state.selectedReleaseVersion === release.version ? 'active' : '') + '" data-release-version="' + release.version + '"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:start;"><div><strong style="color: black;">' + text(release.name || release.version) + '</strong><div class="meta">' + release.version + ' · ' + release.channel + '</div></div><span class="badge">' + release.channel + '</span></div><div class="meta" style="margin-top:.6rem;">' + text(release.description || '') + '</div></button>').join('')
        releasesList.querySelectorAll('[data-release-version]').forEach((button) => {
          button.addEventListener('click', () => {
            state.selectedReleaseVersion = button.getAttribute('data-release-version') || ''
            fillReleaseForm()
            renderReleases()
          })
        })
      }

      function renderInstances() {
        instancesList.innerHTML = state.instances.map((instance) => '<button type="button" class="item ' + (state.selectedInstanceSlug === instance.slug ? 'active' : '') + '" data-instance-slug="' + instance.slug + '"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:start;"><div><strong style="color: black;">' + text(instance.name || instance.slug) + '</strong><div class="meta">' + instance.slug + ' · ' + text(instance.environment || '') + '</div></div><span class="badge">' + text(instance.payment?.provider || 'none') + '</span></div><div class="meta" style="margin-top:.6rem;">Commission ' + text(instance.payment?.commissionPercent ?? 0) + '% · Compte ' + text(instance.payment?.connectedAccountId || 'non configuré') + '</div></button>').join('')
        instancesList.querySelectorAll('[data-instance-slug]').forEach((button) => {
          button.addEventListener('click', () => {
            state.selectedInstanceSlug = button.getAttribute('data-instance-slug') || ''
            fillInstanceForm()
            renderInstances()
          })
        })
      }

      function fillTemplateForm() {
        const template = state.templates.find(item => item.slug === state.selectedTemplateSlug)
        if (!template) return
        templateForm.slug.value = template.slug
        templateForm.icon.value = text(template.icon)
        templateForm.labelFr.value = text(template.label?.fr)
        templateForm.labelEn.value = text(template.label?.en)
        templateForm.descriptionFr.value = text(template.description?.fr)
        templateForm.descriptionEn.value = text(template.description?.en)
        templateForm.previewImage.value = text(template.previewImage)
        templateForm.highlights.value = encodeHighlights(template.highlights)
        templateForm.themeNames.value = encodeThemeNames(template.themeNames)
      }

      function fillReleaseForm() {
        const release = state.releases.find(item => item.version === state.selectedReleaseVersion)
        if (!release) return
        releaseForm.version.value = release.version
        releaseForm.channel.value = release.channel
        releaseForm.name.value = text(release.name)
        releaseForm.icon.value = text(release.icon)
        releaseForm.description.value = text(release.description)
        releaseForm.image.value = text(release.image)
        releaseForm.changelogMarkdown.value = text(release.changelogMarkdown)
      }

      function fillInstanceForm() {
        const instance = state.instances.find(item => item.slug === state.selectedInstanceSlug)
        if (!instance) return
        instanceForm.slug.value = text(instance.slug)
        instanceForm.name.value = text(instance.name)
        instanceForm.environment.value = text(instance.environment)
        instanceForm.releaseChannel.value = text(instance.releaseChannel)
        instanceForm.provider.value = text(instance.payment?.provider || 'none')
        instanceForm.commissionPercent.value = text(instance.payment?.commissionPercent ?? 0)
        instanceForm.connectedAccountId.value = text(instance.payment?.connectedAccountId)
        instanceForm.connectedAccountLabel.value = text(instance.payment?.connectedAccountLabel)
      }

      async function loadTemplates() {
        templateStatus.textContent = 'Chargement des templates...'
        state.templates = await fetchJson('/admin/api/templates')
        if (!state.selectedTemplateSlug && state.templates[0]) state.selectedTemplateSlug = state.templates[0].slug
        renderTemplates()
        fillTemplateForm()
        templateStatus.textContent = ''
      }

      async function loadReleases() {
        releaseStatus.textContent = 'Chargement des releases...'
        state.releases = await fetchJson('/admin/api/releases')
        if (!state.selectedReleaseVersion && state.releases[0]) state.selectedReleaseVersion = state.releases[0].version
        renderReleases()
        fillReleaseForm()
        releaseStatus.textContent = ''
      }

      async function loadInstances() {
        instanceStatus.textContent = 'Chargement des instances...'
        state.instances = await fetchJson('/admin/api/instances')
        if (!state.selectedInstanceSlug && state.instances[0]) state.selectedInstanceSlug = state.instances[0].slug
        renderInstances()
        fillInstanceForm()
        instanceStatus.textContent = ''
      }

      templateForm.addEventListener('submit', async (event) => {
        event.preventDefault()
        const slug = text(templateForm.slug.value).trim()
        if (!slug) return
        templateStatus.textContent = 'Enregistrement du template...'
        try {
          await fetchJson('/admin/api/templates/' + encodeURIComponent(slug) + '/meta', {
            method: 'PATCH',
            body: JSON.stringify({
              icon: templateForm.icon.value,
              label: { fr: templateForm.labelFr.value, en: templateForm.labelEn.value },
              description: { fr: templateForm.descriptionFr.value, en: templateForm.descriptionEn.value },
              previewImage: templateForm.previewImage.value,
              highlights: parseHighlights(templateForm.highlights.value),
              themeNames: parseThemeNames(templateForm.themeNames.value)
            })
          })
          await loadTemplates()
          templateStatus.textContent = 'Template enregistré.'
        } catch (error) {
          templateStatus.textContent = error.message || 'Erreur de sauvegarde.'
        }
      })

      releaseForm.addEventListener('submit', async (event) => {
        event.preventDefault()
        const version = text(releaseForm.version.value).trim()
        if (!version) return
        releaseStatus.textContent = 'Enregistrement de la release...'
        try {
          await fetchJson('/admin/api/releases/' + encodeURIComponent(version) + '/meta', {
            method: 'PATCH',
            body: JSON.stringify({
              name: releaseForm.name.value,
              icon: releaseForm.icon.value,
              description: releaseForm.description.value,
              image: releaseForm.image.value,
              changelogMarkdown: releaseForm.changelogMarkdown.value
            })
          })
          await loadReleases()
          releaseStatus.textContent = 'Release enregistrée.'
        } catch (error) {
          releaseStatus.textContent = error.message || 'Erreur de sauvegarde.'
        }
      })

      instanceForm.addEventListener('submit', async (event) => {
        event.preventDefault()
        const slug = text(instanceForm.slug.value).trim()
        if (!slug) return
        instanceStatus.textContent = 'Enregistrement de l’instance...'
        try {
          await fetchJson('/admin/api/instances/' + encodeURIComponent(slug) + '/payment', {
            method: 'PATCH',
            body: JSON.stringify({
              provider: text(instanceForm.provider.value).trim() === 'stripe_connect' ? 'stripe_connect' : 'none',
              commissionPercent: Number(instanceForm.commissionPercent.value || 0),
              connectedAccountId: instanceForm.connectedAccountId.value,
              connectedAccountLabel: instanceForm.connectedAccountLabel.value
            })
          })
          await loadInstances()
          instanceStatus.textContent = 'Instance enregistrée.'
        } catch (error) {
          instanceStatus.textContent = error.message || 'Erreur de sauvegarde.'
        }
      })

      $('#refresh-templates').addEventListener('click', () => loadTemplates().catch((error) => { templateStatus.textContent = error.message || 'Erreur' }))
      $('#refresh-releases').addEventListener('click', () => loadReleases().catch((error) => { releaseStatus.textContent = error.message || 'Erreur' }))
      $('#refresh-instances').addEventListener('click', () => loadInstances().catch((error) => { instanceStatus.textContent = error.message || 'Erreur' }))

      Promise.all([loadTemplates(), loadReleases(), loadInstances()]).catch((error) => {
        templateStatus.textContent = error.message || 'Erreur'
        releaseStatus.textContent = error.message || 'Erreur'
        instanceStatus.textContent = error.message || 'Erreur'
      })
    </script>
  </body>
</html>`)
}

async function adminListTemplates(request: Request, env: Env) {
  requireOwnerSession(request, env)
  const result = await env.DB.prepare('SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY updated_at DESC').all<any>()
  return json(await Promise.all(result.results.map(row => rowToTemplate(env, request, row))))
}

async function adminUpdateTemplateMeta(request: Request, env: Env, slug: string) {
  requireOwnerSession(request, env)
  const body = await readJson<any>(request)
  const row = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!row) return json({ message: 'Template not found' }, { status: 404 })

  await env.DB.prepare(
    'UPDATE templates SET label_json = ?, description_json = ?, icon = ?, preview_image = ?, highlights_json = ?, theme_names_json = ?, updated_at = ? WHERE slug = ?'
  ).bind(
    JSON.stringify(body.label || parseJson<LocalizedText>(row.label_json, { fr: slug, en: slug })),
    JSON.stringify(body.description || parseJson<LocalizedText>(row.description_json, { fr: '', en: '' })),
    body.icon || row.icon,
    body.previewImage ?? row.preview_image,
    JSON.stringify(Array.isArray(body.highlights) ? body.highlights : parseJson<LocalizedText[]>(row.highlights_json, [])),
    JSON.stringify(Array.isArray(body.themeNames) ? body.themeNames : parseJson<string[]>(row.theme_names_json, [])),
    nowIso(),
    slug
  ).run()

  const updated = await env.DB.prepare('SELECT * FROM templates WHERE slug = ?').bind(slug).first<any>()
  return json(await rowToTemplate(env, request, updated))
}

async function adminListReleases(request: Request, env: Env) {
  requireOwnerSession(request, env)
  const result = await env.DB.prepare('SELECT * FROM releases ORDER BY created_at DESC').all<any>()
  return json(result.results.map(row => decorateRelease(request, env, row)))
}

async function adminListInstances(request: Request, env: Env) {
  requireOwnerSession(request, env)
  const result = await env.DB.prepare('SELECT * FROM instances ORDER BY updated_at DESC').all<any>()
  return json(result.results.map(row => decorateInstance(row, env)))
}

async function adminUpdateInstancePayment(request: Request, env: Env, slug: string) {
  requireOwnerSession(request, env)
  const row = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(slug).first<any>()
  if (!row) return json({ message: 'Instance not found' }, { status: 404 })

  const body = await readJson<any>(request)
  const mergedSettings = normalizePaymentSettings({
    ...parseInstancePaymentSettings(row, env),
    ...(body || {})
  })

  await env.DB.prepare(
    'UPDATE instances SET payment_provider = ?, payment_settings_json = ?, updated_at = ? WHERE slug = ?'
  ).bind(
    mergedSettings.provider,
    JSON.stringify(mergedSettings),
    nowIso(),
    slug
  ).run()

  const updated = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(slug).first<any>()
  return json(decorateInstance(updated, env))
}

async function adminUpdateReleaseMeta(request: Request, env: Env, version: string) {
  requireOwnerSession(request, env)
  const body = await readJson<ReleaseRegistryMeta>(request)
  const row = await env.DB.prepare('SELECT * FROM releases WHERE version = ?').bind(version).first<any>()
  if (!row) return json({ message: 'Release not found' }, { status: 404 })

  const manifest = parseJson<Record<string, any>>(row.manifest_json, {})
  manifest.registryMeta = {
    ...parseReleaseMeta(manifest),
    name: body.name?.trim() || version,
    description: body.description?.trim() || '',
    icon: body.icon?.trim() || '',
    image: body.image?.trim() || '',
    changelogMarkdown: body.changelogMarkdown?.trim() || ''
  }

  await env.DB.prepare('UPDATE releases SET manifest_json = ? WHERE version = ?').bind(JSON.stringify(manifest), version).run()
  const updated = await env.DB.prepare('SELECT * FROM releases WHERE version = ?').bind(version).first<any>()
  return json(decorateRelease(request, env, updated))
}

function normalizeTranslationLocale(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function normalizeTranslationText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

async function getCachedTranslation(
  env: Env,
  sourceLocale: string,
  targetLocale: string,
  sourceText: string
) {
  const sourceHash = await sha256Hex(`${sourceLocale}:${targetLocale}:${sourceText}`)
  const row = await env.DB.prepare(
    `SELECT id, translated_text, provider
     FROM translation_cache
     WHERE source_locale = ? AND target_locale = ? AND source_hash = ?
     LIMIT 1`
  ).bind(sourceLocale, targetLocale, sourceHash).first<any>()

  if (!row?.translated_text) {
    return null
  }

  return {
    id: String(row.id),
    translatedText: String(row.translated_text),
    provider: String(row.provider || 'workers_ai'),
    sourceHash
  }
}

async function saveTranslationCache(
  env: Env,
  sourceLocale: string,
  targetLocale: string,
  sourceText: string,
  translatedText: string
) {
  const sourceHash = await sha256Hex(`${sourceLocale}:${targetLocale}:${sourceText}`)
  const now = nowIso()
  const existing = await env.DB.prepare(
    'SELECT id FROM translation_cache WHERE source_locale = ? AND target_locale = ? AND source_hash = ? LIMIT 1'
  ).bind(sourceLocale, targetLocale, sourceHash).first<any>()

  if (existing?.id) {
    await env.DB.prepare(
      `UPDATE translation_cache
       SET translated_text = ?, provider = 'workers_ai', updated_at = ?
       WHERE id = ?`
    ).bind(
      translatedText,
      now,
      existing.id
    ).run()
    return existing.id as string
  }

  const id = newId('tr')
  await env.DB.prepare(
    `INSERT INTO translation_cache
     (id, source_locale, target_locale, source_text, source_hash, translated_text, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'workers_ai', ?, ?)`
  ).bind(
    id,
    sourceLocale,
    targetLocale,
    sourceText,
    sourceHash,
    translatedText,
    now,
    now
  ).run()

  return id
}

async function translateWithWorkersAI(env: Env, sourceText: string, sourceLocale: string, targetLocale: string) {
  const response = await env.AI.run("@cf/meta/m2m100-1.2b", {
    text: sourceText,
    source_lang: sourceLocale,
    target_lang: targetLocale
  }) as any

  if (typeof response === 'string') {
    return response.trim()
  }

  if (Array.isArray(response?.result) && response.result[0]?.translated_text) {
    return String(response.result[0].translated_text).trim()
  }

  if (typeof response?.translated_text === 'string') {
    return response.translated_text.trim()
  }

  if (typeof response?.translation === 'string') {
    return response.translation.trim()
  }

  throw new Error('Workers AI returned an unexpected translation payload.')
}

async function translateText(request: Request, env: Env) {
  const body = await readJson<TranslationBatchRequest>(request)
  const items = Array.isArray(body?.items) ? body.items : []

  if (!items.length) {
    return json({ items: [], translated: 0, cached: 0 })
  }

  const results: TranslationBatchItemResult[] = []
  let translated = 0
  let cached = 0

  for (const item of items) {
    const sourceLocale = normalizeTranslationLocale(item?.sourceLocale)
    const targetLocale = normalizeTranslationLocale(item?.targetLocale)
    const sourceText = normalizeTranslationText(item?.text)

    if (!sourceLocale || !targetLocale || !sourceText) {
      continue
    }

    if (sourceLocale === targetLocale) {
      results.push({
        sourceLocale,
        targetLocale,
        sourceText,
        translatedText: sourceText,
        cached: true
      })
      cached += 1
      continue
    }

    const cacheHit = await getCachedTranslation(env, sourceLocale, targetLocale, sourceText)
    if (cacheHit?.translatedText) {
      results.push({
        sourceLocale,
        targetLocale,
        sourceText,
        translatedText: cacheHit.translatedText,
        cached: true
      })
      cached += 1
      continue
    }

    const translatedText = await translateWithWorkersAI(env, sourceText, sourceLocale, targetLocale)
    if (!translatedText) {
      continue
    }

    await saveTranslationCache(env, sourceLocale, targetLocale, sourceText, translatedText)
    results.push({
      sourceLocale,
      targetLocale,
      sourceText,
      translatedText,
      cached: false
    })
    translated += 1
  }

  return json({
    items: results,
    translated,
    cached
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/health') {
        return json({ ok: true, at: nowIso() })
      }

      if (url.pathname === '/admin' && request.method === 'GET') {
        return isOwnerSession(request, env) ? renderAdminAppPage() : renderAdminLoginPage()
      }

      if (url.pathname === '/admin/login' && request.method === 'POST') {
        const form = await request.formData()
        const token = String(form.get('token') || '').trim()
        if (!token || token !== getOwnerApiKey(env)) {
          return renderAdminLoginPage('Clé owner invalide.')
        }
        return redirect('/admin', {
          headers: {
            'set-cookie': `modula_registry_owner_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Secure`
          }
        })
      }

      if (url.pathname === '/admin/logout' && request.method === 'POST') {
        return redirect('/admin', {
          headers: {
            'set-cookie': 'modula_registry_owner_session=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0'
          }
        })
      }

      if (url.pathname === '/admin/api/instances' && request.method === 'GET') {
        return await adminListInstances(request, env)
      }

      const adminInstancePaymentMatch = url.pathname.match(/^\/admin\/api\/instances\/([^/]+)\/payment$/)
      if (adminInstancePaymentMatch && request.method === 'PATCH') {
        return await adminUpdateInstancePayment(request, env, decodeURIComponent(adminInstancePaymentMatch[1]!))
      }

      const templatesResponse = await handleTemplatesModule(
        { request, url, env },
        {
          adminListTemplates,
          adminUpdateTemplateMeta,
          introspectAuth,
          createTemplateAsset,
          getTemplateAssetBySource,
          downloadTemplateAsset,
          publicTemplateAsset,
          authorize,
          listTemplates,
          createTemplate,
          createTemplateVersion,
          deleteTemplateVersion,
          publishTemplateVersion,
          getTemplate,
          deleteTemplate
        }
      )
      if (templatesResponse) return templatesResponse

      const updateResponse = await handleUpdateModule(
        { request, url, env },
        {
          adminListReleases,
          adminUpdateReleaseMeta,
          authorize,
          listReleases,
          createRelease,
          downloadReleaseArtifact,
          getRelease,
          createDeployment,
          updateDeployment,
          listDeployments,
          getDeployment
        }
      )
      if (updateResponse) return updateResponse

      const instancesResponse = await handleInstancesModule(
        { request, url, env },
        {
          authorize,
          registerInstance
        }
      )
      if (instancesResponse) return instancesResponse

      const paymentsResponse = await handlePaymentsModule(
        { request, url, env },
        {
          getInstancePaymentConfig,
          updateInstancePaymentConfig,
          createStripeConnectCheckout,
          getPaymentStatusBySession,
          getPaymentStatusByOrder,
          handleStripeWebhook
        }
      )
      if (paymentsResponse) return paymentsResponse

      const translationsResponse = await handleTranslationsModule(
        { request, url, env },
        {
          authorize,
          translateText
        }
      )
      if (translationsResponse) return translationsResponse

      const gmailSyncResponse = await handleGmailSyncModule({ request, url, env })
      if (gmailSyncResponse) return gmailSyncResponse

      return new Response('Not found', { status: 404 })
    } catch (error) {
      if (error instanceof Response) return error
      return json({
        message: error instanceof Error ? error.message : 'Unexpected error'
      }, { status: 500 })
    }
  }
}
