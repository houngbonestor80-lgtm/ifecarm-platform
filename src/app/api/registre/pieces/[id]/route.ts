import { traiterLecturePiece, traiterSuppressionPiece } from '@/registre/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterLecturePiece(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionPiece(request, (await ctx.params).id)
