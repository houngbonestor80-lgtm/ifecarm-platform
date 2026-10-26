import { traiterResultat, traiterSuppressionPoint } from '@/inspections/routes'

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string, itemId: string }> }) {
  const { id, itemId } = await ctx.params
  return traiterResultat(request, id, itemId)
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string, itemId: string }> }) {
  const { id, itemId } = await ctx.params
  return traiterSuppressionPoint(request, id, itemId)
}
