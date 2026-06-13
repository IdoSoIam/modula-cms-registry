export interface Env {
  DB: D1Database
  ASSETS: R2Bucket
  API_KEYS_JSON?: string
  PUBLIC_BASE_URL?: string
  OWNER_API_KEY?: string
}

type LocalizedText = { fr: string, en: string }
type ReleaseRegistryMeta = {
  name?: string
  description?: string
  icon?: string
  image?: string
  changelogMarkdown?: string
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

function getApiKeys(env: Env) {
  return parseJson<Record<string, string>>(env.API_KEYS_JSON, {})
}

function getOwnerApiKey(env: Env) {
  return env.OWNER_API_KEY?.trim() || Object.values(getApiKeys(env))[0] || ''
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

async function authorize(request: Request, env: Env) {
  const header = request.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const valid = Object.values(getApiKeys(env)).includes(token)
  if (!valid) {
    throw new Response('Unauthorized', { status: 401 })
  }
}

async function readJson<T>(request: Request) {
  return await request.json() as T
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

  return {
    id: row.id,
    slug: row.slug,
    label: parseJson<LocalizedText>(row.label_json, { fr: row.slug, en: row.slug }),
    description: parseJson<LocalizedText>(row.description_json, { fr: '', en: '' }),
    icon: row.icon,
    previewImage: row.preview_image,
    highlights: parseJson<LocalizedText[]>(row.highlights_json, []),
    themeNames: parseJson<string[]>(row.theme_names_json, []),
    sourceType: row.source_type,
    deletedAt: row.deleted_at,
    currentVersionId: row.current_version_id,
    currentVersionNumber: currentVersion?.version_number ?? null,
    snapshot: currentVersion ? parseJson(currentVersion.snapshot_json, null) : null,
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

async function createTemplate(request: Request, env: Env) {
  const body = await readJson<any>(request)
  const id = newId('tpl')
  const versionId = newId('tplver')
  const now = nowIso()
  const sourceType = body.sourceType === 'system' ? 'system' : 'custom'
  const labelJson = JSON.stringify(body.label || { fr: body.slug, en: body.slug })
  const descriptionJson = JSON.stringify(body.description || { fr: '', en: '' })
  const icon = body.icon || 'mdi:view-dashboard-edit-outline'
  const previewImage = body.previewImage || ''
  const highlightsJson = JSON.stringify(body.highlights || [])
  const themeNamesJson = JSON.stringify(body.themeNames || [])

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

  const row = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first<any>()
  return json(await rowToTemplate(env, request, row), { status: 201 })
}

async function createTemplateVersion(request: Request, env: Env, slug: string) {
  const body = await readJson<any>(request)
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })

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

async function publishTemplateVersion(request: Request, env: Env, slug: string, versionId: string) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })
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

async function deleteTemplateVersion(request: Request, env: Env, slug: string, versionId: string) {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE slug = ? AND deleted_at IS NULL').bind(slug).first<any>()
  if (!template) return json({ message: 'Template not found' }, { status: 404 })

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

async function deleteTemplate(env: Env, slug: string) {
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
    downloadUrl: `${baseUrl(env, request)}/v1/template-assets/${id}/download`
  }, { status: 201 })
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
  if (existing) {
    await env.DB.prepare(
      'UPDATE instances SET name = ?, environment = ?, release_channel = ?, last_seen_at = ?, updated_at = ? WHERE slug = ?'
    ).bind(body.name, body.environment || 'development', body.releaseChannel || 'stable', now, now, body.slug).run()
  } else {
    await env.DB.prepare(
      'INSERT INTO instances (id, slug, name, environment, release_channel, current_version, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)'
    ).bind(newId('inst'), body.slug, body.name, body.environment || 'development', body.releaseChannel || 'stable', now, now, now).run()
  }
  const row = await env.DB.prepare('SELECT * FROM instances WHERE slug = ?').bind(body.slug).first<any>()
  return json({
    id: row.id,
    slug: row.slug,
    name: row.name,
    environment: row.environment,
    releaseChannel: row.release_channel,
    currentVersion: row.current_version,
    lastSeenAt: row.last_seen_at
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
    </main>
    <script>
      const state = { templates: [], releases: [], selectedTemplateSlug: '', selectedReleaseVersion: '' }
      const $ = (selector) => document.querySelector(selector)
      const templatesList = $('#templates-list')
      const releasesList = $('#releases-list')
      const templateForm = $('#template-form')
      const releaseForm = $('#release-form')
      const templateStatus = $('#template-status')
      const releaseStatus = $('#release-status')

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

      $('#refresh-templates').addEventListener('click', () => loadTemplates().catch((error) => { templateStatus.textContent = error.message || 'Erreur' }))
      $('#refresh-releases').addEventListener('click', () => loadReleases().catch((error) => { releaseStatus.textContent = error.message || 'Erreur' }))

      Promise.all([loadTemplates(), loadReleases()]).catch((error) => {
        templateStatus.textContent = error.message || 'Erreur'
        releaseStatus.textContent = error.message || 'Erreur'
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

      if (url.pathname === '/admin/api/templates' && request.method === 'GET') {
        return await adminListTemplates(request, env)
      }

      const adminTemplateMetaMatch = url.pathname.match(/^\/admin\/api\/templates\/([^/]+)\/meta$/)
      if (adminTemplateMetaMatch && request.method === 'PATCH') {
        return await adminUpdateTemplateMeta(request, env, decodeURIComponent(adminTemplateMetaMatch[1]!))
      }

      if (url.pathname === '/admin/api/releases' && request.method === 'GET') {
        return await adminListReleases(request, env)
      }

      const adminReleaseMetaMatch = url.pathname.match(/^\/admin\/api\/releases\/([^/]+)\/meta$/)
      if (adminReleaseMetaMatch && request.method === 'PATCH') {
        return await adminUpdateReleaseMeta(request, env, decodeURIComponent(adminReleaseMetaMatch[1]!))
      }

      if (url.pathname === '/v1/template-assets' && request.method === 'POST') {
        await authorize(request, env)
        return await createTemplateAsset(request, env)
      }

      const templateAssetMatch = url.pathname.match(/^\/v1\/template-assets\/([^/]+)\/download$/)
      if (templateAssetMatch) {
        await authorize(request, env)
        return await downloadTemplateAsset(request, env, templateAssetMatch[1]!)
      }

      if (url.pathname === '/v1/templates' && request.method === 'GET') {
        await authorize(request, env)
        return await listTemplates(request, env)
      }
      if (url.pathname === '/v1/templates' && request.method === 'POST') {
        await authorize(request, env)
        return await createTemplate(request, env)
      }

      const versionMatch = url.pathname.match(/^\/v1\/templates\/([^/]+)\/versions$/)
      if (versionMatch && request.method === 'POST') {
        await authorize(request, env)
        return await createTemplateVersion(request, env, decodeURIComponent(versionMatch[1]!))
      }

      const deleteVersionMatch = url.pathname.match(/^\/v1\/templates\/([^/]+)\/versions\/([^/]+)$/)
      if (deleteVersionMatch && request.method === 'DELETE') {
        await authorize(request, env)
        return await deleteTemplateVersion(request, env, decodeURIComponent(deleteVersionMatch[1]!), decodeURIComponent(deleteVersionMatch[2]!))
      }

      const publishMatch = url.pathname.match(/^\/v1\/templates\/([^/]+)\/publish\/([^/]+)$/)
      if (publishMatch && request.method === 'POST') {
        await authorize(request, env)
        return await publishTemplateVersion(request, env, decodeURIComponent(publishMatch[1]!), decodeURIComponent(publishMatch[2]!))
      }

      const templateMatch = url.pathname.match(/^\/v1\/templates\/([^/]+)$/)
      if (templateMatch && request.method === 'GET') {
        await authorize(request, env)
        return await getTemplate(request, env, decodeURIComponent(templateMatch[1]!))
      }
      if (templateMatch && request.method === 'DELETE') {
        await authorize(request, env)
        return await deleteTemplate(env, decodeURIComponent(templateMatch[1]!))
      }

      if (url.pathname === '/v1/releases' && request.method === 'GET') {
        await authorize(request, env)
        return await listReleases(request, env)
      }
      if (url.pathname === '/v1/releases' && request.method === 'POST') {
        await authorize(request, env)
        return await createRelease(request, env)
      }

      const releaseArtifactMatch = url.pathname.match(/^\/v1\/releases\/([^/]+)\/artifact$/)
      if (releaseArtifactMatch) {
        await authorize(request, env)
        return await downloadReleaseArtifact(env, decodeURIComponent(releaseArtifactMatch[1]!))
      }

      const releaseMatch = url.pathname.match(/^\/v1\/releases\/([^/]+)$/)
      if (releaseMatch && request.method === 'GET') {
        await authorize(request, env)
        return await getRelease(request, env, decodeURIComponent(releaseMatch[1]!))
      }

      if (url.pathname === '/v1/instances/register' && request.method === 'POST') {
        await authorize(request, env)
        return await registerInstance(request, env)
      }

      if (url.pathname === '/v1/deployments' && request.method === 'POST') {
        await authorize(request, env)
        return await createDeployment(request, env)
      }

      if (url.pathname === '/v1/deployments' && request.method === 'GET') {
        await authorize(request, env)
        return await listDeployments(request, env)
      }

      const deploymentMatch = url.pathname.match(/^\/v1\/deployments\/([^/]+)$/)
      if (deploymentMatch && request.method === 'GET') {
        await authorize(request, env)
        return await getDeployment(env, decodeURIComponent(deploymentMatch[1]!))
      }
      if (deploymentMatch && request.method === 'PATCH') {
        await authorize(request, env)
        return await updateDeployment(request, env, decodeURIComponent(deploymentMatch[1]!))
      }

      return new Response('Not found', { status: 404 })
    } catch (error) {
      if (error instanceof Response) return error
      return json({
        message: error instanceof Error ? error.message : 'Unexpected error'
      }, { status: 500 })
    }
  }
}
