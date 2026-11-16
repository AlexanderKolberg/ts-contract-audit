import { createWidget, listWidgets } from './generated'

export interface CreateWidgetResult {
  id: string
  name: string
  createdAt: string
}

export async function widgetResult(): Promise<CreateWidgetResult> {
  const { id, name, createdAt } = await createWidget()
  return { id, name, createdAt }
}

export interface ListWidgetsRequest {
  limit?: number
  status?: 'active' | 'inactive'
}

export function widgetQuery(request: ListWidgetsRequest) {
  return listWidgets({ query: { limit: request.limit, status: request.status } })
}

export interface EmptyState {
  title: string
  description: string
}
