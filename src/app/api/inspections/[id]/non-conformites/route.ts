import { traiterNonConformite } from '@/inspections/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterNonConformite(request, (await ctx.params).id)
}
