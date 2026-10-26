import { traiterHoraire } from '@/inspections/routes'

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterHoraire(request, (await ctx.params).id)
}
