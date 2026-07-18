import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string> {
  transform(value: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const isLegacyObjectId = /^[0-9a-f]{24}$/i.test(value);
    if (!isLegacyObjectId && !isUuid) {
      throw new BadRequestException('Invalid id');
    }
    return value;
  }
}
