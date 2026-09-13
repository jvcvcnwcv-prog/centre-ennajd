import { ReportGenerator } from "@/components/reports/ReportGenerator";
import { useI18n } from "@/lib/i18n";

export default function Reports() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("reportGenerator")}</h1>
        <p className="text-sm text-muted-foreground">{t("reportGeneratorSubtitle")}</p>
      </div>
      <ReportGenerator />
    </div>
  );
}