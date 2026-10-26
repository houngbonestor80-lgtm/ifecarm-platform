import { traiterModificationPays, traiterSuppressionPays } from '@/pays/routes'

type Ctx = { params: Promise<{ code: string }> }
export const PATCH = async (request: Request, ctx: Ctx) => traiterModificationPays(request, (await ctx.params).code)
export const DELETE = async (request: Request, ctx: Ctx) => traiterSuppressionPays(request, (await ctx.params).code)
