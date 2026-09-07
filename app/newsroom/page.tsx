import type { Metadata } from "next";
import Newsroom from "../../components/Newsroom";

export const metadata: Metadata = {
  title: "Newsroom — Draft Cockpit",
  description: "Every player, every update, ranked by what matters.",
};

export default function NewsroomPage() {
  return <Newsroom />;
}
