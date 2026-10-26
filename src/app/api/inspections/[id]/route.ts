import { traiterDetail, traiterIntervenants, traiterSuppression } from '@/inspections/routes'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterDetail(request, (await ctx.params).id)
}

/** Noms des intervenants (inspecteur, représentant du client). */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterIntervenants(request, (await ctx.params).id)
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterSuppression(request, (await ctx.params).id)
}
