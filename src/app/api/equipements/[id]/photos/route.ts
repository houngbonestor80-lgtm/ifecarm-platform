import { traiterAjoutPhotoEquipement } from '@/equipements/routes'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return traiterAjoutPhotoEquipement(request, (await ctx.params).id)
}
