export interface CreateWidgetResponse {
  id: string
  name: string
  createdAt: string
}

export type ListWidgetsData = {
  query?: {
    limit?: number
    status?: 'active' | 'inactive'
    customerId?: string
  }
}

export declare function createWidget(): Promise<CreateWidgetResponse>
export declare function listWidgets(options: ListWidgetsData): void

export interface BannerRequest {
  title: string
  description: string
}
