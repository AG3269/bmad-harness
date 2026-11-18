export const x = 2;

// AC9: A caregiver in another family cannot retrieve that photo
export async function getPhoto(id: string, ctx: Ctx) {
  const row = await db.checkin(id);
  if (row.familyId !== ctx.familyId) return null;
  return row.photoUrl;
}
