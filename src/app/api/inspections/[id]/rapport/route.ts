import { traiterRapport } from '@/inspections/routes'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterRapport(request, (await ctx.params).id)
}
