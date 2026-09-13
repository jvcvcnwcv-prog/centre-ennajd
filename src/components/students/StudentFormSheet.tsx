import { useEffect, useState } from "react";
import { toast } from "sonner";

import { SubjectEnrollmentPicker } from "@/components/students/SubjectEnrollmentPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useEnnajdState } from "@/hooks/use-ennajd-state";
import { REGISTRATION_FEE_DEFAULT } from "@/lib/ennajd-billing";
import {
  LEVELS,
  isGroupTypeApplicable,
  isTrackRequired,
} from "@/lib/ennajd-taxonomy";
import { useI18n } from "@/lib/i18n";
import type {
  Level,
  RegistrationFee,
  Student,
  SubjectEnrollment,
  Track,
} from "@/types/ennajd";

interface StudentFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  student?: Student | null;
}

interface FormState {
  fullName: string;
  whatsappPhone: string;
  parentPhone: string;
  level: Level;
  track: Track | null;
  enrollments: SubjectEnrollment[];
  /** Create mode only — "paid the 100 DH registration fee at registration". */
  feePaidAtRegistration: boolean;
}

const emptyForm: FormState = {
  fullName: "",
  whatsappPhone: "",
  parentPhone: "",
  level: "T.C",
  track: null,
  enrollments: [],
  feePaidAtRegistration: false,
};

function splitFullName(fullName: string): {
  firstName: string;
  lastName: string;
} {
  const parts = fullName.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
}

export function StudentFormSheet({
  open,
  onOpenChange,
  student,
}: StudentFormSheetProps) {
  const { t } = useI18n();
  const addStudent = useEnnajdState((s) => s.addStudent);
  const updateStudent = useEnnajdState((s) => s.updateStudent);
  const [form, setForm] = useState<FormState>(emptyForm);

  useEffect(() => {
    if (student) {
      setForm({
        fullName: `${student.firstName} ${student.lastName}`.trim(),
        whatsappPhone: student.whatsappPhone,
        parentPhone: student.parentPhone,
        level: student.level,
        track: student.track,
        enrollments: student.enrollments,
        feePaidAtRegistration: false,
      });
    } else {
      setForm(emptyForm);
    }
  }, [student, open]);

  const trackRequired = isTrackRequired(form.level);
  // Registration fee checkbox: create mode only, and only when the picked
  // enrollments include ≥1 non-Small (Rule A standard) class. Small-only
  // students are exempt — no fee field is stored for them at all.
  const showFeeCheckbox =
    !student &&
    form.enrollments.some((e) => e.groupType !== "Small");

  function handleLevelChange(level: Level) {
    setForm((f) => ({
      ...f,
      level,
      track: null,
      enrollments: [],
    }));
  }

  function handleTrackChange(track: Track) {
    setForm((f) => ({ ...f, track, enrollments: [] }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const { firstName, lastName } = splitFullName(form.fullName);
    if (!firstName || !lastName) {
      toast.error(t("required"));
      return;
    }
    if (trackRequired && !form.track) {
      toast.error(t("required"));
      return;
    }
    const missingGroupType = form.enrollments.some(
      (enrollment) =>
        isGroupTypeApplicable(form.level, enrollment.subject) && !enrollment.groupType,
    );
    if (missingGroupType) {
      toast.error(t("invalidCombination"));
      return;
    }

    // New students owe the 100 DH registration fee unless it was paid at
    // registration (checkbox) or the student is Small-group-only (exempt —
    // no fee field stored). Legacy/existing students keep their stored fee;
    // edit mode never rewrites it (managed in the wallet instead).
    let registrationFee: RegistrationFee | undefined;
    if (!student && showFeeCheckbox) {
      registrationFee = form.feePaidAtRegistration
        ? {
            amountDue: REGISTRATION_FEE_DEFAULT,
            amountPaid: REGISTRATION_FEE_DEFAULT,
            settledAt: new Date().toISOString(),
          }
        : {
            amountDue: REGISTRATION_FEE_DEFAULT,
            amountPaid: 0,
          };
    }

    const payload = {
      firstName,
      lastName,
      whatsappPhone: form.whatsappPhone.trim(),
      parentPhone: form.parentPhone.trim(),
      level: form.level,
      track: trackRequired ? form.track : null,
      enrollments: form.enrollments,
      ...(registrationFee ? { registrationFee } : {}),
    };

    if (student) {
      updateStudent(student.id, payload);
    } else {
      addStudent(payload);
    }
    toast.success(t("studentSaved"));
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{student ? t("editStudent") : t("addStudent")}</SheetTitle>
          <SheetDescription>{t("subjectsAndSessions")}</SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5 pb-6">
          <div className="space-y-1.5">
            <Label>{t("fullName")}</Label>
            <Input
              className="rounded-lg"
              value={form.fullName}
              placeholder={t("fullNamePlaceholder")}
              onChange={(e) =>
                setForm((f) => ({ ...f, fullName: e.target.value }))
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("whatsappPhone")}</Label>
              <Input
                type="tel"
                className="rounded-lg"
                value={form.whatsappPhone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, whatsappPhone: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("parentPhone")}</Label>
              <Input
                type="tel"
                className="rounded-lg"
                value={form.parentPhone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, parentPhone: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("level")}</Label>
              <Select value={form.level} onValueChange={handleLevelChange}>
                <SelectTrigger className="rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((lvl) => (
                    <SelectItem key={lvl} value={lvl}>
                      {lvl}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {trackRequired && (
              <div className="space-y-1.5">
                <Label>{t("track")}</Label>
                <Select
                  value={form.track ?? undefined}
                  onValueChange={handleTrackChange}
                >
                  <SelectTrigger className="rounded-lg">
                    <SelectValue placeholder={t("selectTrack")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="s.x">s.x</SelectItem>
                    <SelectItem value="s.m">s.m</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-semibold">
              {t("subjectsAndSessions")}
            </Label>
            <SubjectEnrollmentPicker
              level={form.level}
              track={form.track}
              enrollments={form.enrollments}
              onChange={(enrollments) =>
                setForm((f) => ({ ...f, enrollments }))
              }
            />
          </div>

          {showFeeCheckbox && (
            <div className="space-y-1.5 rounded-xl border border-border bg-muted/40 p-3">
              <label
                htmlFor="fee-paid-at-registration"
                className="flex cursor-pointer items-start gap-2.5"
              >
                <Checkbox
                  id="fee-paid-at-registration"
                  className="mt-0.5"
                  checked={form.feePaidAtRegistration}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({
                      ...f,
                      feePaidAtRegistration: checked === true,
                    }))
                  }
                />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">
                    {t("registrationFeePaidAtRegistration")}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("registrationFeeCollectHint")}
                  </span>
                </span>
              </label>
            </div>
          )}

          <SheetFooter className="gap-2 sm:justify-start">
            <Button type="submit" className="rounded-lg">
              {t("save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}