import { traiterTerminer } from '@/inspections/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterTerminer(request, (await ctx.params).id)
}
