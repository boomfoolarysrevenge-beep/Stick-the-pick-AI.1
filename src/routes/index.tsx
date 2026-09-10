import { createFileRoute } from "@tanstack/react-router";
import { PickStudio } from "@/components/pick-studio";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <PickStudio />;
}
