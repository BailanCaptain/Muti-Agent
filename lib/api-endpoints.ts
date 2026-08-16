export function resolveApiUrl(configuredUrl: string, runtimeHostname: string | undefined): string {
  if (!runtimeHostname) return configuredUrl

  const url = new URL(configuredUrl)
  url.hostname = runtimeHostname

  const resolved = url.toString()
  if (!configuredUrl.endsWith("/") && url.pathname === "/" && !url.search && !url.hash) {
    return resolved.slice(0, -1)
  }
  return resolved
}

function getBrowserHostname(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.hostname
}

function getConfiguredApiHttpUrl(): string {
  return (
    process.env.NEXT_PUBLIC_API_HTTP_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    "http://localhost:8787"
  )
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function isUploadPath(pathname: string): boolean {
  return pathname === "/uploads" || pathname.startsWith("/uploads/")
}

export function getApiHttpBaseUrl(
  runtimeHostname: string | undefined = getBrowserHostname(),
  configuredUrl: string = getConfiguredApiHttpUrl(),
): string {
  return resolveApiUrl(configuredUrl, runtimeHostname)
}

export function resolveApiResourceUrl(
  resourceUrl: string,
  runtimeHostname: string | undefined = getBrowserHostname(),
  configuredApiUrl: string = getConfiguredApiHttpUrl(),
): string {
  const configuredApi = new URL(configuredApiUrl)
  const resource = new URL(resourceUrl, configuredApi)
  const isRootRelative = resourceUrl.startsWith("/") && !resourceUrl.startsWith("//")
  const isInternalUpload =
    isUploadPath(resource.pathname) &&
    (isRootRelative ||
      resource.origin === configuredApi.origin ||
      isLoopbackHostname(resource.hostname))

  if (!isInternalUpload) return resourceUrl

  const runtimeApi = new URL(resolveApiUrl(configuredApiUrl, runtimeHostname))
  return new URL(
    `${resource.pathname}${resource.search}${resource.hash}`,
    runtimeApi.origin,
  ).toString()
}

export function normalizeApiResourceUrlForStorage(
  resourceUrl: string,
  configuredApiUrl: string = getConfiguredApiHttpUrl(),
): string {
  const configuredApi = new URL(configuredApiUrl)
  const resource = new URL(resourceUrl, configuredApi)
  const isRootRelative = resourceUrl.startsWith("/") && !resourceUrl.startsWith("//")
  const isInternalUpload =
    isUploadPath(resource.pathname) && (isRootRelative || resource.origin === configuredApi.origin)

  if (!isInternalUpload) return resourceUrl
  return `${resource.pathname}${resource.search}${resource.hash}`
}

export function getApiWebSocketUrl(
  runtimeHostname: string | undefined = getBrowserHostname(),
  configuredUrl: string = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:8787/ws",
): string {
  return resolveApiUrl(configuredUrl, runtimeHostname)
}
