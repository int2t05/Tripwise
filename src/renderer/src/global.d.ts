/** 为 renderer 声明受控 preload 接口。 */
import type { TripwiseApi } from '@shared/types'

declare global {
  interface Window {
    tripwise: TripwiseApi
  }
}

export {}
