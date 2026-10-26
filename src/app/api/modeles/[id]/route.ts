import { traiterDetailModele, traiterModificationModele, traiterSuppressionModele } from '@/modeles/routes'

type Ctx = { params: Promise<{ id: string }> }
export const GET = async (request: Request, ctx: Ctx) => traiterDetailModele(request, (await ctx.params).id)
export const PUT = async (request: Request, ctx: Ctx) => traiterModificationModele(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: Ctx) => traiterSuppressionModele(request, (await ctx.params).id)
