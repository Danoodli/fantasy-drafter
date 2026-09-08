import type { Metadata } from "next";
import MockBoard from "../../components/MockBoard";

export const metadata: Metadata = {
  title: "Mock draft board — Draft Cockpit",
  description: "A DraftKings-style draft board to test screen sync and paste import against.",
  robots: { index: false },
};

export default function MockBoardPage() {
  return <MockBoard />;
}
