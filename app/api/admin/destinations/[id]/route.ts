import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDatabase } from "@/lib/mongodb";
import { deleteFromCloudinary } from "@/lib/cloudinary";
import type { Destination, UpdateDestinationDTO } from "@/lib/mongodb-types";

/**
 * GET /api/destinations/[id]
 * Fetch a single destination by ID with related packages
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = await getDatabase();
    const { id } = params;

    // Validate ObjectId
    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid destination ID" },
        { status: 400 }
      );
    }

    // Fetch destination
    const destination = await db
      .collection<Destination>("destinations")
      .findOne({ _id: new ObjectId(id) });

    if (!destination) {
      return NextResponse.json(
        { success: false, error: "Destination not found" },
        { status: 404 }
      );
    }

    // Optionally fetch associated packages
    const includePackages =
      request.nextUrl.searchParams.get("includePackages") === "true";
    let packages = [];

    if (includePackages) {
      packages = await db
        .collection("packages")
        .find({ destinationId: new ObjectId(id) })
        .sort({ featured: -1, price: 1 })
        .toArray();
    }

    return NextResponse.json({
      success: true,
      destination,
      packages: includePackages ? packages : undefined,
    });
  } catch (error) {
    console.error("Error fetching destination:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch destination" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/destinations/[id]
 * Update a destination
 * Requires: authentication and admin role
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // TODO: Add authentication middleware
    const db = await getDatabase();
    const { id } = params;
    const body: UpdateDestinationDTO = await request.json();

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid destination ID" },
        { status: 400 }
      );
    }

    // Build update document
    const updateDoc: UpdateDestinationDTO & { updatedAt: Date; slug?: string } =
      {
        ...body,
        updatedAt: new Date(),
      };

    // If name is updated, regenerate slug
    if (body.name) {
      updateDoc.slug = body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    }

    // Update destination
    const result = await db
      .collection("destinations")
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateDoc },
        { returnDocument: "after" }
      );

    if (!result) {
      return NextResponse.json(
        { success: false, error: "Destination not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      destination: result,
      message: "Destination updated successfully",
    });
  } catch (error) {
    console.error("Error updating destination:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update destination" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/destinations/[id]
 * Delete a destination and all associated data
 * Requires: authentication and admin role
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // TODO: Add authentication middleware
    const db = await getDatabase();
    const { id } = params;

    if (!ObjectId.isValid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid destination ID" },
        { status: 400 }
      );
    }

    const destinationObjectId = new ObjectId(id);

    // Fetch destination to get image public IDs
    const destination = await db
      .collection<Destination>("destinations")
      .findOne({ _id: destinationObjectId });

    if (!destination) {
      return NextResponse.json(
        { success: false, error: "Destination not found" },
        { status: 404 }
      );
    }

    // Use transaction for atomic operations
    const session = db.client.startSession();

    try {
      await session.withTransaction(async () => {
        // 1. Find all packages for this destination
        const packages = await db
          .collection("packages")
          .find({ destinationId: destinationObjectId })
          .toArray();

        const packageIds = packages.map((pkg) => pkg._id);

        // 2. For each package, delete related data
        for (const pkg of packages) {
          // Find bookings for this package
          const bookings = await db
            .collection("bookings")
            .find({ packageId: pkg._id })
            .toArray();

          const bookingIds = bookings.map((booking) => booking._id);

          // Delete payments for these bookings
          if (bookingIds.length > 0) {
            await db
              .collection("payments")
              .deleteMany({ bookingId: { $in: bookingIds } }, { session });
          }

          // Delete bookings for this package
          await db
            .collection("bookings")
            .deleteMany({ packageId: pkg._id }, { session });

          // Delete package reviews
          await db
            .collection("package_reviews")
            .deleteMany({ packageId: pkg._id }, { session });

          // Delete package image from Cloudinary
          if (pkg.image?.publicId) {
            await deleteFromCloudinary(pkg.image.publicId).catch((err) =>
              console.error("Failed to delete package image:", err)
            );
          }
        }

        // 3. Delete all packages for this destination
        await db
          .collection("packages")
          .deleteMany({ destinationId: destinationObjectId }, { session });

        // 4. Delete destination reviews
        await db
          .collection("destination_reviews")
          .deleteMany({ destinationId: destinationObjectId }, { session });

        // 5. Delete destination images from Cloudinary
        const deletePromises: Promise<boolean>[] = [];

        if (destination.bannerImage?.publicId) {
          deletePromises.push(
            deleteFromCloudinary(destination.bannerImage.publicId)
          );
        }

        if (destination.gallery && destination.gallery.length > 0) {
          destination.gallery.forEach((img) => {
            if (img.publicId) {
              deletePromises.push(deleteFromCloudinary(img.publicId));
            }
          });
        }

        // Execute all deletions
        await Promise.allSettled(deletePromises);

        // 6. Delete destination document
        await db
          .collection("destinations")
          .deleteOne({ _id: destinationObjectId }, { session });
      });
    } finally {
      await session.endSession();
    }

    return NextResponse.json({
      success: true,
      message: "Destination and all associated data deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting destination:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete destination" },
      { status: 500 }
    );
  }
}
