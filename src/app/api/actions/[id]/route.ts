import { traiterStatutAction } from '@/inspections/routes'

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterStatutAction(request, (await ctx.params).id)
}
