import { BrandedIcon, type BrandedIconName } from "@/components/shared/BrandedIcon";

type StatIconProps = {
  name: BrandedIconName<"stats">;
  size?: number;
};

export function StatIcon({ name, size = 40 }: StatIconProps) {
  return <BrandedIcon group="stats" name={name} size={size} />;
}
