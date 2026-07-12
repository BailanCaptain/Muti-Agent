import { DigestView } from "@/components/digest/digest-view"

/** /digest/YYYY-MM-DD：单日网页版日报（全量分栏，可点 tabs） */
export default async function DigestDatePage({
  params,
}: {
  params: Promise<{ date: string }>
}) {
  const { date } = await params
  return <DigestView date={date} />
}
