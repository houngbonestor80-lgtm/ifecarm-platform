import { traiterAjoutPhoto } from '@/inspections/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterAjoutPhoto(request, (await ctx.params).id)
}
