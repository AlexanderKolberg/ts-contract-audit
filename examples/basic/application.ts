import type { CreateWidgetResponse, ListWidgetsData } from './generated'

export interface CreateWidgetResult {
  id: string
  name: string
  createdAt: string
}

export function widgetResult(response: CreateWidgetResponse): CreateWidgetResult {
  return response
}

export interface ListWidgetsRequest {
  limit?: number
  status?: 'active' | 'inactive'
}

export function widgetQuery(request: ListWidgetsRequest): ListWidgetsData['query'] {
  return request
}

export interface EmptyState {
  title: string
  description: string
}
