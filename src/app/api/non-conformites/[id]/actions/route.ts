import { traiterPlanAction } from '@/inspections/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterPlanAction(request, (await ctx.params).id)
}
