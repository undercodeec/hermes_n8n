import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { CrmProofDto } from './dto/crm-proof.dto';
import { MobileRefreshDto } from './dto/mobile-refresh.dto';
import { MobileAuthGuard } from './mobile-auth.guard';
import { WebAuthGuard } from './web-auth.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Registrar nuevo usuario interno' })
  @ApiResponse({ status: 201, description: 'Usuario registrado exitosamente' })
  @ApiResponse({ status: 409, description: 'Email ya registrado' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión' })
  @ApiResponse({ status: 200, description: 'Login exitoso' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('crm-proof')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Canjear una prueba OTP de Undercodeec por un JWT de Hermes CRM',
  })
  @ApiResponse({ status: 200, description: 'Acceso CRM concedido' })
  @ApiResponse({
    status: 401,
    description: 'Prueba inválida, vencida o reutilizada',
  })
  async loginWithCrmProof(@Body() dto: CrmProofDto) {
    return this.authService.loginWithCrmProof(dto.proof, dto.existingRefreshToken);
  }

  @Post('web/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotar refresh web sin renovar la inactividad' })
  async webRefresh(@Body() dto: MobileRefreshDto) {
    return this.authService.refreshWeb(dto.refreshToken);
  }

  @Post('web/logout-refresh')
  @HttpCode(HttpStatus.OK)
  async webLogoutWithRefresh(@Body() dto: MobileRefreshDto) {
    return this.authService.logoutWebWithRefresh(dto.refreshToken);
  }

  @Get('web/session')
  @UseGuards(WebAuthGuard)
  @ApiBearerAuth()
  async webSession(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.checkWeb(user.id, user.sessionId);
  }

  // Only foreground gestures; never called by timers, GET, SSE or refresh.
  @Post('web/activity')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebAuthGuard)
  @ApiBearerAuth()
  async webActivity(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.webActivity(user.id, user.sessionId);
  }

  @Post('web/logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebAuthGuard)
  @ApiBearerAuth()
  async webLogout(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.logoutWeb(user.id, user.sessionId);
  }

  @Post('web/revoke-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebAuthGuard)
  @ApiBearerAuth()
  async revokeAllWeb(@CurrentUser() user: { id: string; email: string }) {
    return this.authService.revokeAllWebForOperator(user.id, user.email);
  }

  @Post('mobile/crm-proof')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Canjear prueba OTP móvil por sesión revocable (un teléfono)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Usuario, accessToken móvil, refreshToken rotatorio y expiresAt',
  })
  @ApiResponse({
    status: 401,
    description:
      'Prueba inválida, vencida, reutilizada u operador no autorizado',
  })
  async mobileCrmProof(@Body() dto: CrmProofDto) {
    return this.authService.loginMobileWithCrmProof(dto.proof);
  }

  @Post('mobile/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotar refresh vigente sin extender la inactividad',
  })
  @ApiResponse({
    status: 200,
    description:
      'Nuevo accessToken y refreshToken; persistir antes de desbloquear',
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh consumido, vencido o revocado',
  })
  async mobileRefresh(@Body() dto: MobileRefreshDto) {
    return this.authService.refreshMobile(dto.refreshToken);
  }

  @Post('mobile/logout-refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Revocar con refresh vigente incluso si expiró el access JWT; no rota credenciales',
  })
  @ApiResponse({ status: 200, description: 'Sesión móvil revocada' })
  @ApiResponse({
    status: 401,
    description: 'Refresh consumido o sesión ya vencida/revocada',
  })
  async mobileLogoutWithRefresh(@Body() dto: MobileRefreshDto) {
    return this.authService.logoutMobileWithRefresh(dto.refreshToken);
  }

  @Get('mobile/session')
  @UseGuards(MobileAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Comprobar sesión móvil sin renovar actividad' })
  @ApiResponse({
    status: 200,
    description:
      'active, expiresAt e idleRemainingMs (reloj servidor; sin credenciales)',
  })
  @ApiResponse({
    status: 401,
    description: 'Sesión inválida, revocada o inactiva',
  })
  async mobileSession(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.checkMobile(user.id, user.sessionId);
  }

  // Call only on actual user interaction; never from background polling/profile/refresh.
  @Post('mobile/activity')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MobileAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Registrar interacción real en primer plano y renovar inactividad',
  })
  @ApiResponse({ status: 200, description: 'active y expiresAt renovado' })
  @ApiResponse({ status: 401, description: 'Sesión inválida o vencida' })
  async mobileActivity(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.mobileActivity(user.id, user.sessionId);
  }

  @Post('mobile/logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(MobileAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revocar sesión móvil con access JWT válido' })
  @ApiResponse({ status: 200, description: 'Sesión revocada' })
  async mobileLogout(@CurrentUser() user: { id: string; sessionId: string }) {
    return this.authService.logoutMobile(user.id, user.sessionId);
  }

  // Existing web operator can revoke lost phones without ending the web session.
  @Post('mobile/revoke-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Revocar teléfonos desde web sin cerrar web; solo operador ADMIN autorizado',
  })
  @ApiResponse({
    status: 200,
    description: 'Número de sesiones móviles revocadas',
  })
  @ApiResponse({ status: 401, description: 'Operador web no autorizado' })
  async revokeAllMobile(@CurrentUser() user: { id: string; email: string }) {
    return this.authService.revokeAllMobileForOperator(user.id, user.email);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Obtener perfil del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  async getProfile(@CurrentUser('id') userId: string) {
    return this.authService.getProfile(userId);
  }
}
