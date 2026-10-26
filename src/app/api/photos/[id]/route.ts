import { traiterLecturePhoto, traiterSuppressionPhoto } from '@/inspections/routes'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterLecturePhoto(request, (await ctx.params).id)
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterSuppressionPhoto(request, (await ctx.params).id)
}
