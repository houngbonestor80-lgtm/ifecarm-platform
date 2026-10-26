import { traiterConversionEntreprise, traiterSuppressionEntreprise } from '@/auth/routes'

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterSuppressionEntreprise(request, (await ctx.params).id)
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterConversionEntreprise(request, (await ctx.params).id)
}
