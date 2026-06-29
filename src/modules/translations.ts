import type { ModuleContext, TranslationsModuleHandlers } from "./types"

export async function handleTranslationsModule(
  context: ModuleContext,
  handlers: TranslationsModuleHandlers
) {
  const { request, url, env } = context

  if (url.pathname === "/v1/translations/text" && request.method === "POST") {
    await handlers.authorize(request, env)
    return await handlers.translateText(request, env)
  }

  return null
}
