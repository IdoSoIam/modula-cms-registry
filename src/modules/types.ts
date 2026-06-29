import type { Env } from "../index"

export type ModuleContext = {
  request: Request
  url: URL
  env: Env
}

export type TemplateModuleHandlers = {
  adminListTemplates(request: Request, env: Env): Promise<Response>
  adminUpdateTemplateMeta(request: Request, env: Env, slug: string): Promise<Response>
  introspectAuth(request: Request, env: Env): Promise<Response>
  createTemplateAsset(request: Request, env: Env): Promise<Response>
  getTemplateAssetBySource(request: Request, env: Env): Promise<Response>
  downloadTemplateAsset(request: Request, env: Env, id: string): Promise<Response>
  publicTemplateAsset(env: Env, id: string): Promise<Response>
  authorize(request: Request, env: Env): Promise<unknown>
  listTemplates(request: Request, env: Env): Promise<Response>
  createTemplate(request: Request, env: Env, capabilities: any): Promise<Response>
  createTemplateVersion(request: Request, env: Env, slug: string, capabilities: any): Promise<Response>
  deleteTemplateVersion(request: Request, env: Env, slug: string, versionId: string, capabilities: any): Promise<Response>
  publishTemplateVersion(request: Request, env: Env, slug: string, versionId: string, capabilities: any): Promise<Response>
  getTemplate(request: Request, env: Env, slug: string): Promise<Response>
  deleteTemplate(env: Env, slug: string, capabilities: any): Promise<Response>
}

export type UpdateModuleHandlers = {
  adminListReleases(request: Request, env: Env): Promise<Response>
  adminUpdateReleaseMeta(request: Request, env: Env, version: string): Promise<Response>
  authorize(request: Request, env: Env): Promise<unknown>
  listReleases(request: Request, env: Env): Promise<Response>
  createRelease(request: Request, env: Env): Promise<Response>
  downloadReleaseArtifact(env: Env, version: string): Promise<Response>
  getRelease(request: Request, env: Env, version: string): Promise<Response>
  createDeployment(request: Request, env: Env): Promise<Response>
  updateDeployment(request: Request, env: Env, id: string): Promise<Response>
  listDeployments(request: Request, env: Env): Promise<Response>
  getDeployment(env: Env, id: string): Promise<Response>
}

export type PaymentsModuleHandlers = {
  getInstancePaymentConfig(request: Request, env: Env): Promise<Response>
  updateInstancePaymentConfig(request: Request, env: Env): Promise<Response>
  createStripeConnectCheckout(request: Request, env: Env): Promise<Response>
  getPaymentStatusBySession(request: Request, env: Env, sessionId: string): Promise<Response>
  getPaymentStatusByOrder(request: Request, env: Env, orderId: string): Promise<Response>
  handleStripeWebhook(request: Request, env: Env): Promise<Response>
}

export type TranslationsModuleHandlers = {
  authorize(request: Request, env: Env): Promise<unknown>
  translateText(request: Request, env: Env): Promise<Response>
}

export type InstancesModuleHandlers = {
  authorize(request: Request, env: Env): Promise<unknown>
  registerInstance(request: Request, env: Env): Promise<Response>
}
