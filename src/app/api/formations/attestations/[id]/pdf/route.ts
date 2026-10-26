import { traiterPdfAttestation } from '@/formations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterPdfAttestation(request, (await ctx.params).id)
