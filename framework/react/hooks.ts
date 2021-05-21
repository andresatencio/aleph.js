import { useContext, useMemo } from 'https://esm.sh/react@17.0.2'
import type { RouterURL } from '../../types.ts'
import events from '../core/events.ts'
import { RouterContext } from './context.ts'
import { inDeno } from './helper.ts'

export class AsyncUseDenoError extends Error { }

/**
 * `useRouter` returns current `RouterURL` of page routing.
 *
 * ```tsx
 * export default function App() {
 *   const { locale, pathname, routePath, params, query } = useRouter()
 *   return <p>{pathname}</p>
 * }
 * ```
 */
export function useRouter(): RouterURL {
  return useContext(RouterContext)
}

/**
 * `useDeno` hacks in Deno runtime at build time(SSR).
 *
 * ```tsx
 * export default function App() {
 *   const version = useDeno(() => Deno.version.deno)
 *   return <p>{version}</p>
 * }
 * ```
 */
export function useDeno<T = any>(callback: () => (T | Promise<T>), options?: { key?: string | number, revalidate?: number }): T {
  const { key, revalidate } = options || {}
  const uuid = arguments[2] // generated by compiler
  const router = useRouter()
  const id = useMemo(() => [uuid, key].filter(Boolean).join('-'), [key])

  return useMemo(() => {
    const global = window as any
    const href = router.toString()
    const pagedataUrl = `pagedata://${href}`
    const dataUrl = `${pagedataUrl}#${id}`

    if (inDeno) {
      const renderingData = global[`rendering-${pagedataUrl}`]

      if (renderingData && id in renderingData) {
        return renderingData[id]  // 2+ pass
      }

      const value = callback()
      const expires = typeof revalidate === 'number' && !isNaN(revalidate) ? Date.now() + revalidate * 1000 : 0
      events.emit(`useDeno-${pagedataUrl}`, { id, value, expires })

      // thow an `AsyncUseDenoError` to break current rendering
      if (value instanceof Promise) {
        throw new AsyncUseDenoError()
      }

      renderingData[id] = value
      return value
    }

    const data = global[dataUrl]
    return data?.value
  }, [id, router])
}
