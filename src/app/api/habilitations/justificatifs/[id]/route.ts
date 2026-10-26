import { traiterLectureJustificatif, traiterSuppressionJustificatif } from '@/habilitations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterLectureJustificatif(request, (await ctx.params).id)
export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionJustificatif(request, (await ctx.params).id)
