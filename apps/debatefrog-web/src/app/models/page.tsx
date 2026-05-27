import { ModelQualityReport, type ModelEvalReport } from "@/components/model-quality-report";
import report from "../../../evals/results/latest.json";

export const dynamic = "force-static";

export default function ModelsPage() {
  return <ModelQualityReport report={report as ModelEvalReport} />;
}
