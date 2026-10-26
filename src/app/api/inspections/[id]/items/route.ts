import { traiterAjoutPoint } from '@/inspections/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterAjoutPoint(request, (await ctx.params).id)
}
