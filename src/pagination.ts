import { applyDecorators, type Type as ClassType } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query params of every paginated list (api.md §1). Query DTOs **extend** it:
 * `skip` is a prototype getter, lost by `IntersectionType` or a `{ ...query }` spread.
 * An endpoint lowers the max by overriding `limit` with its own `@Max()`.
 */
export class PageParams {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PageMeta;
}

/** Swagger mirror of `PageMeta`, for response DTOs that nest it (`@ApiProperty({ type: PageMetaDto })`). */
export class PageMetaDto implements PageMeta {
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
}

export function paginate<T>(
  data: T[],
  total: number,
  params: Pick<PageParams, 'page' | 'limit'>,
): PaginatedResult<T> {
  return {
    data,
    meta: {
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

/**
 * Swagger 200 response for a list endpoint returning `PaginatedResult<T>`.
 * Without `item`, `data` is documented as `object[]`.
 */
export function ApiPaginatedResponse(item?: ClassType<unknown>, description = 'Paginated list.') {
  return applyDecorators(
    ApiExtraModels(PageMetaDto, ...(item ? [item] : [])),
    ApiOkResponse({
      description,
      schema: {
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: item ? { $ref: getSchemaPath(item) } : { type: 'object' } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
        },
      },
    }),
  );
}
