import { traiterModificationEquipement, traiterSuppressionEquipement } from '@/equipements/routes'

type Ctx = { params: Promise<{ id: string }> }
export const PATCH = async (request: Request, ctx: Ctx) => traiterModificationEquipement(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: Ctx) => traiterSuppressionEquipement(request, (await ctx.params).id)
