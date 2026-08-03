import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from "class-validator";

export class SendRelationshipRequestDto {
  @IsString()
  @Length(6, 30)
  phoneNumber: string;

  @IsEnum(["CUSTOMER", "SUPPLIER"])
  connectionType: "CUSTOMER" | "SUPPLIER";

  @IsEnum(["CUSTOMERS", "SUPPLIERS"])
  @IsOptional()
  requestSource?: "CUSTOMERS" | "SUPPLIERS";

  /**
   * Personal name of the contact (required when receiver is not registered).
   */
  @IsString()
  @IsOptional()
  personalName?: string;

  /**
   * Business/trade name of the contact (required when receiver is not registered).
   */
  @IsString()
  @IsOptional()
  businessName?: string;

  /**
   * Opening balance — provided only when sending from the Customers screen.
   * The Supplier screen defers this to the receiver upon acceptance.
   */
  @IsNumber()
  @IsOptional()
  openingBalance?: number;

  /**
   * Credit limit — provided only when sending from the Customers screen.
   */
  @IsNumber()
  @Min(0)
  @IsOptional()
  creditLimit?: number;

  @IsString()
  @IsOptional()
  billingCycle?: string;

  @IsString()
  @IsOptional()
  dueDate?: string;

  @IsOptional()
  showPrices?: boolean;
}
