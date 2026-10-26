import { traiterSuppressionNote } from '@/notes/routes'

export const DELETE = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuppressionNote(request, (await ctx.params).id)
